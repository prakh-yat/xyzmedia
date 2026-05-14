/**
 * Revert one previous sync run. Reads the changelog written by that run and
 * undoes it:
 *
 *   - Products created → DELETE
 *   - Products updated → restore from the run's old/baseline CSV (re-PUT the
 *     DTO built from that row, since that DTO is what existed before the run)
 *   - Collections auto-created → DELETE
 *
 * State updates: deleted products are removed from state.products; restored
 * products get their payloadSha/priceSha rewritten to match the old DTO so a
 * subsequent sync won't see them as "changed" and re-push them.
 *
 * Supports dry-run (logs every action but skips the network call + state mutation).
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse } from 'csv-parse';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { GhlClient } from '../ghl/client.js';
import { deleteCollection } from '../ghl/collections.js';
import { deleteProduct, updateProduct } from '../ghl/products.js';
import { updatePrice } from '../ghl/prices.js';
import { buildCreatePriceDto } from '../mapping/price.js';
import { buildCreateProductDto, resolveCollectionIds } from '../mapping/product.js';
import type { Tokens } from '../oauth/flow.js';
import { StateStore } from '../state.js';
import { syncImagesForProduct } from './images.js';

interface ChangelogEntry {
  code: string;
  name: string;
  productId: string;
  priceId: string | null;
}

interface ChangelogCollection {
  name: string;
  id: string;
  slug: string;
}

export interface Changelog {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  newFile?: string;
  oldFile?: string;
  products: {
    created: ChangelogEntry[];
    updated: ChangelogEntry[];
    recovered: ChangelogEntry[];
  };
  collections: {
    addedByDiff: ChangelogCollection[];
    autoCreated: ChangelogCollection[];
    /** Deduped union — the revert delete target. */
    addedAll: ChangelogCollection[];
  };
}

export interface RevertProgressEvent {
  index: number;
  total: number;
  status: 'deleted' | 'restored' | 'skipped' | 'failed';
  kind: 'product' | 'collection';
  code?: string;
  name: string;
  id: string;
  error?: string;
}

export interface RevertOpts {
  cfg: Config;
  logger: Logger;
  runId: string;
  /** The runId of the original sync we're reverting. */
  targetRunId: string;
  dryRun?: boolean;
  onProgress?: (ev: RevertProgressEvent) => void;
  signal?: AbortSignal;
}

export interface RevertResult {
  targetRunId: string;
  durationMs: number;
  dryRun: boolean;
  counts: {
    productsDeleted: number;
    productsRestored: number;
    productsFailed: number;
    collectionsDeleted: number;
    collectionsFailed: number;
    skipped: number;
  };
  outcomes: RevertProgressEvent[];
}

const DELETE_CONCURRENCY = 4;

export async function runRevert(opts: RevertOpts): Promise<RevertResult> {
  const { cfg, logger, targetRunId } = opts;
  const dryRun = opts.dryRun ?? false;
  const start = Date.now();

  logger.info(
    { targetRunId, dryRun, runId: opts.runId },
    `▶ revert starting — target run ${targetRunId}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  // 1. Load the changelog written by the run we're reverting.
  const changelogPath = join(cfg.reportDir, `changelog-${targetRunId}.json`);
  let changelog: Changelog;
  try {
    const raw = await readFile(changelogPath, 'utf8');
    changelog = JSON.parse(raw) as Changelog;
  } catch (err) {
    throw new Error(
      `cannot revert run ${targetRunId}: changelog not found at ${changelogPath}. ` +
        'This run pre-dates per-run changelog tracking — use the wipe tool instead. ' +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  logger.info(
    {
      targetRunId,
      created: changelog.products.created.length,
      updated: changelog.products.updated.length,
      autoCreatedCollections: changelog.collections.autoCreated.length,
    },
    'loaded changelog',
  );

  // 2. Build GHL client + state store. Even in dry-run we instantiate the
  //    client so we can fail fast on missing tokens, but we never call write
  //    methods unless dryRun=false.
  const tokens: Tokens = JSON.parse(await readFile(cfg.tokensFile, 'utf8'));
  const client = new GhlClient({
    baseUrl: cfg.ghlBaseUrl,
    apiVersion: cfg.ghlApiVersion,
    oauth: {
      clientId: cfg.ghlClientId,
      clientSecret: cfg.ghlClientSecret,
      redirectUri: cfg.ghlRedirectUri,
    },
    tokens,
    persistTokens: async (t: Tokens) => {
      const { writeFile, rename } = await import('node:fs/promises');
      const tmp = `${cfg.tokensFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, cfg.tokensFile);
    },
    logger,
  });
  const state = await StateStore.load(cfg.stateFile);

  // 3. Pre-load the baseline CSV. Updates need their old row to rebuild the DTO.
  const oldRows = new Map<string, Record<string, string>>();
  if (changelog.products.updated.length > 0 && changelog.oldFile) {
    const oldPath = resolve(join('./archive', changelog.oldFile));
    logger.info({ oldFile: changelog.oldFile, path: oldPath }, 'loading baseline CSV for restore');
    const parser = createReadStream(oldPath).pipe(
      parse({ columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }),
    );
    for await (const row of parser) {
      const r = row as Record<string, string>;
      if (r.Code) oldRows.set(r.Code.trim(), r);
    }
    logger.info({ count: oldRows.size }, 'baseline CSV loaded');
  } else if (changelog.products.updated.length > 0) {
    logger.warn(
      { updatedCount: changelog.products.updated.length },
      'changelog has updated products but no oldFile recorded — those updates cannot be restored, only created products will be deleted',
    );
  }

  const outcomes: RevertProgressEvent[] = [];
  const counts = {
    productsDeleted: 0,
    productsRestored: 0,
    productsFailed: 0,
    collectionsDeleted: 0,
    collectionsFailed: 0,
    skipped: 0,
  };
  const collectionsToDeleteTotal = (changelog.collections.addedAll
    ?? changelog.collections.autoCreated
    ?? []).length;
  const total =
    changelog.products.created.length +
    changelog.products.updated.length +
    collectionsToDeleteTotal;
  let index = 0;

  const emit = (ev: RevertProgressEvent) => {
    outcomes.push(ev);
    if (opts.onProgress) opts.onProgress(ev);
  };

  // 4. Delete created products (in parallel, throttled by GhlClient bucket too).
  const limit = pLimit(DELETE_CONCURRENCY);
  logger.info(
    { phase: 'delete-created', count: changelog.products.created.length },
    '--- phase 1: delete created products ---',
  );

  await Promise.all(
    changelog.products.created.map((p) =>
      limit(async () => {
        if (opts.signal?.aborted) {
          index += 1;
          counts.skipped += 1;
          emit({ index, total, status: 'skipped', kind: 'product', code: p.code, name: p.name, id: p.productId });
          return;
        }
        logger.info(
          { code: p.code, name: p.name, productId: p.productId, priceId: p.priceId },
          `→ deleting product "${p.name}" (code ${p.code}, id ${p.productId})${dryRun ? ' [dry-run]' : ''}`,
        );
        try {
          if (!dryRun) {
            await deleteProduct(client, p.productId, cfg.ghlLocationId);
            state.deleteProduct(p.code);
            await state.save();
          }
          counts.productsDeleted += 1;
          logger.info(
            { code: p.code, name: p.name, productId: p.productId },
            `✓ product deleted "${p.name}" (id ${p.productId})${dryRun ? ' [dry-run]' : ''}`,
          );
          index += 1;
          emit({ index, total, status: 'deleted', kind: 'product', code: p.code, name: p.name, id: p.productId });
        } catch (err) {
          counts.productsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { code: p.code, name: p.name, productId: p.productId, err: msg },
            `✗ failed to delete "${p.name}" (id ${p.productId}): ${msg}`,
          );
          index += 1;
          emit({ index, total, status: 'failed', kind: 'product', code: p.code, name: p.name, id: p.productId, error: msg });
        }
      }),
    ),
  );

  // 5. Restore updated products by re-PUTting the DTO built from the OLD csv row.
  logger.info(
    { phase: 'restore-updated', count: changelog.products.updated.length },
    '--- phase 2: restore updated products from baseline ---',
  );

  // Build a category-name → collection-id map from state.collections. Used to
  // resolve old.csv categories back to GHL ids during restore. We snapshot it
  // ONCE here (before phase 3 deletes anything) so restored products can
  // still reference collections we're about to remove.
  const stateSnapForResolve = state.snapshot();
  const nameToId = new Map<string, string>();
  for (const [name, rec] of Object.entries(stateSnapForResolve.collections)) {
    nameToId.set(name, rec.id);
  }

  await Promise.all(
    changelog.products.updated.map((p) =>
      limit(async () => {
        if (opts.signal?.aborted) {
          index += 1;
          counts.skipped += 1;
          emit({ index, total, status: 'skipped', kind: 'product', code: p.code, name: p.name, id: p.productId });
          return;
        }
        const oldRow = oldRows.get(p.code);
        if (!oldRow) {
          counts.skipped += 1;
          logger.warn(
            { code: p.code, name: p.name },
            '· skipping restore — code not found in baseline CSV (or no oldFile recorded)',
          );
          index += 1;
          emit({ index, total, status: 'skipped', kind: 'product', code: p.code, name: p.name, id: p.productId });
          return;
        }

        // --- Image count revert ---
        // The product may have gained or lost images during the sync. Use the
        // OLD csv's ImageCount to restore the exact set: take cached medias for
        // idx 0..N-1. Any indices not cached are re-fetched from the CDN (rare
        // — happens if the original sync removed an image idx then this sync
        // re-introduced it without us ever caching the missing slot).
        const oldImageCount = parseInt(oldRow.ImageCount ?? '0', 10) || 0;
        let mediaUrls: string[] = [];
        const missingIndices: number[] = [];
        for (let i = 0; i < oldImageCount; i++) {
          const cached = state.getMedia(p.code, i);
          if (cached) {
            mediaUrls.push(cached.url);
          } else {
            missingIndices.push(i);
          }
        }
        if (missingIndices.length > 0 && !dryRun) {
          // Re-fetch the missing indices from the CDN. Reuse the image sync
          // helper so we get retries, atomic state writes, etc. — but call it
          // with the missing-count so it only fetches what we need.
          logger.info(
            { code: p.code, missingIndices },
            `· re-fetching ${missingIndices.length} image(s) from CDN to restore baseline imageCount=${oldImageCount}`,
          );
          // syncImagesForProduct returns ALL urls 0..imageCount-1 (gaps removed)
          // so we just call it with the OLD imageCount and overwrite mediaUrls.
          mediaUrls = await syncImagesForProduct({
            client,
            state,
            locationId: cfg.ghlLocationId,
            code: p.code,
            imageCount: oldImageCount,
            logger,
            dryRun: false,
          });
        }

        // --- Category revert ---
        // Resolve old.csv Category1..6 to GHL collection ids via the snapshot
        // taken before phase 3. If a category can't be resolved (e.g. it was
        // renamed since the sync), log + skip that one rather than failing.
        const { ids: collectionIds, unresolved } = resolveCollectionIds(oldRow, nameToId);
        if (unresolved.length > 0) {
          logger.warn(
            { code: p.code, unresolved },
            `· revert: ${unresolved.length} old categor${unresolved.length === 1 ? 'y' : 'ies'} not found in current store — restoring without them`,
          );
        }

        const productDto = buildCreateProductDto(oldRow, {
          locationId: cfg.ghlLocationId,
          mediaUrls,
          collectionIds,
        });
        const priceDto = buildCreatePriceDto(oldRow, {
          locationId: cfg.ghlLocationId,
          currency: cfg.ghlCurrency,
        });

        logger.info(
          {
            code: p.code,
            name: p.name,
            productId: p.productId,
            priceId: p.priceId,
            restoringImages: mediaUrls.length,
            restoringCollections: collectionIds.length,
          },
          `→ restoring "${p.name}" to baseline (id ${p.productId}, ${mediaUrls.length} image${mediaUrls.length === 1 ? '' : 's'}, ${collectionIds.length} categor${collectionIds.length === 1 ? 'y' : 'ies'})${dryRun ? ' [dry-run]' : ''}`,
        );
        try {
          if (!dryRun) {
            await updateProduct(client, p.productId, productDto);
            if (p.priceId) {
              await updatePrice(client, p.productId, p.priceId, priceDto);
            }
            // Reset state shas to '' so a future sync will see the next CSV as
            // a clean diff and pick up the change again if needed.
            state.setProduct(p.code, {
              ghlProductId: p.productId,
              ghlPriceId: p.priceId,
              payloadSha: '',
              priceSha: null,
              syncedAt: new Date().toISOString(),
            });
            await state.save();
          }
          counts.productsRestored += 1;
          logger.info(
            { code: p.code, name: p.name, productId: p.productId, priceId: p.priceId },
            `✓ product restored "${p.name}" (id ${p.productId})${dryRun ? ' [dry-run]' : ''}`,
          );
          index += 1;
          emit({ index, total, status: 'restored', kind: 'product', code: p.code, name: p.name, id: p.productId });
        } catch (err) {
          counts.productsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { code: p.code, name: p.name, productId: p.productId, err: msg },
            `✗ failed to restore "${p.name}" (id ${p.productId}): ${msg}`,
          );
          index += 1;
          emit({ index, total, status: 'failed', kind: 'product', code: p.code, name: p.name, id: p.productId, error: msg });
        }
      }),
    ),
  );

  // 6. Delete every collection this run created (both diff-driven and resolver
  // auto-created, deduped by id). Sequential — small N, keeps logs ordered.
  // We do this AFTER restore so the restored products can still reference any
  // of these collections during the PUT. After this phase, those references
  // become 404s in GHL but the product remains intact with the surviving
  // collection links.
  const collectionsToDelete = changelog.collections.addedAll
    || // back-compat for changelogs written by an interim version
    [
      ...(changelog.collections.autoCreated ?? []),
    ];
  logger.info(
    { phase: 'delete-collections', count: collectionsToDelete.length },
    '--- phase 3: delete collections created by this run ---',
  );

  for (const c of collectionsToDelete) {
    if (opts.signal?.aborted) {
      index += 1;
      counts.skipped += 1;
      emit({ index, total, status: 'skipped', kind: 'collection', name: c.name, id: c.id });
      continue;
    }
    logger.info(
      { name: c.name, id: c.id, slug: c.slug },
      `→ deleting collection "${c.name}" (id ${c.id})${dryRun ? ' [dry-run]' : ''}`,
    );
    try {
      if (!dryRun) {
        await deleteCollection(client, c.id, cfg.ghlLocationId);
        state.deleteCollection(c.name);
        await state.save();
      }
      counts.collectionsDeleted += 1;
      logger.info(
        { name: c.name, id: c.id },
        `✓ collection deleted "${c.name}" (id ${c.id})${dryRun ? ' [dry-run]' : ''}`,
      );
      index += 1;
      emit({ index, total, status: 'deleted', kind: 'collection', name: c.name, id: c.id });
    } catch (err) {
      counts.collectionsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { name: c.name, id: c.id, err: msg },
        `✗ failed to delete collection "${c.name}": ${msg}`,
      );
      index += 1;
      emit({ index, total, status: 'failed', kind: 'collection', name: c.name, id: c.id, error: msg });
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    { targetRunId, durationSec: (durationMs / 1000).toFixed(1), counts },
    `▼ revert done — ${counts.productsDeleted} deleted, ${counts.productsRestored} restored, ${counts.collectionsDeleted} collections removed${dryRun ? ' [dry-run]' : ''}`,
  );

  return { targetRunId, durationMs, dryRun, counts, outcomes };
}
