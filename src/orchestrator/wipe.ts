/**
 * Wipe everything in state.json from GHL.
 *
 * This is the "undo" path for runs that pre-date per-run changelog tracking —
 * we don't know which products/collections came from which run, so we trust
 * state.json as the catalog of everything we've created or touched.
 *
 *   - Every product in state.products → DELETE
 *   - Every collection in state.collections → DELETE
 *   - state.json is cleared on success.
 *
 * Caveats:
 *   - DESTRUCTIVE. There's no undo for this.
 *   - Collections that were already in GHL before our first sync are also in
 *     state.collections (they get cached during sync). We delete those too.
 *     If you only want to delete what *we* created, use the per-run revert
 *     against each run's changelog instead.
 *
 * Supports dry-run.
 */
import { readFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { GhlClient } from '../ghl/client.js';
import { deleteCollection } from '../ghl/collections.js';
import { deleteProduct } from '../ghl/products.js';
import type { Tokens } from '../oauth/flow.js';
import { StateStore } from '../state.js';

export interface WipeProgressEvent {
  index: number;
  total: number;
  status: 'deleted' | 'failed' | 'skipped';
  kind: 'product' | 'collection';
  code?: string;
  name: string;
  id: string;
  error?: string;
}

export interface WipeOpts {
  cfg: Config;
  logger: Logger;
  runId: string;
  dryRun?: boolean;
  onProgress?: (ev: WipeProgressEvent) => void;
  signal?: AbortSignal;
}

export interface WipeResult {
  durationMs: number;
  dryRun: boolean;
  counts: {
    productsDeleted: number;
    productsFailed: number;
    collectionsDeleted: number;
    collectionsFailed: number;
    skipped: number;
  };
  outcomes: WipeProgressEvent[];
}

const DELETE_CONCURRENCY = 4;

export async function runWipe(opts: WipeOpts): Promise<WipeResult> {
  const { cfg, logger } = opts;
  const dryRun = opts.dryRun ?? false;
  const start = Date.now();

  logger.info(
    { dryRun, runId: opts.runId },
    `▶ wipe starting — every tracked product + collection${dryRun ? ' [DRY RUN]' : ''}`,
  );

  // Build GHL client + state store.
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

  const productEntries = state.allProducts();
  const collectionEntries = state.allCollections();
  const total = productEntries.length + collectionEntries.length;

  logger.info(
    { products: productEntries.length, collections: collectionEntries.length, total },
    'wipe scope (from state.json)',
  );

  const outcomes: WipeProgressEvent[] = [];
  const counts = {
    productsDeleted: 0,
    productsFailed: 0,
    collectionsDeleted: 0,
    collectionsFailed: 0,
    skipped: 0,
  };
  let index = 0;

  const emit = (ev: WipeProgressEvent) => {
    outcomes.push(ev);
    if (opts.onProgress) opts.onProgress(ev);
  };

  // 1. Products.
  const limit = pLimit(DELETE_CONCURRENCY);
  logger.info({ count: productEntries.length }, '--- phase 1: delete all products ---');

  await Promise.all(
    productEntries.map(([code, rec]) =>
      limit(async () => {
        if (opts.signal?.aborted) {
          index += 1;
          counts.skipped += 1;
          emit({ index, total, status: 'skipped', kind: 'product', code, name: '', id: rec.ghlProductId });
          return;
        }
        if (!rec.ghlProductId) {
          index += 1;
          counts.skipped += 1;
          emit({ index, total, status: 'skipped', kind: 'product', code, name: '', id: '' });
          return;
        }
        logger.info(
          { code, productId: rec.ghlProductId, priceId: rec.ghlPriceId },
          `→ deleting product (code ${code}, id ${rec.ghlProductId})${dryRun ? ' [dry-run]' : ''}`,
        );
        try {
          if (!dryRun) {
            await deleteProduct(client, rec.ghlProductId, cfg.ghlLocationId);
            state.deleteProduct(code);
            await state.save();
          }
          counts.productsDeleted += 1;
          logger.info(
            { code, productId: rec.ghlProductId },
            `✓ product deleted (code ${code}, id ${rec.ghlProductId})${dryRun ? ' [dry-run]' : ''}`,
          );
          index += 1;
          emit({ index, total, status: 'deleted', kind: 'product', code, name: '', id: rec.ghlProductId });
        } catch (err) {
          counts.productsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { code, productId: rec.ghlProductId, err: msg },
            `✗ failed to delete product (code ${code}, id ${rec.ghlProductId}): ${msg}`,
          );
          index += 1;
          emit({ index, total, status: 'failed', kind: 'product', code, name: '', id: rec.ghlProductId, error: msg });
        }
      }),
    ),
  );

  // 2. Collections.
  logger.info({ count: collectionEntries.length }, '--- phase 2: delete all collections ---');
  for (const [name, rec] of collectionEntries) {
    if (opts.signal?.aborted) {
      index += 1;
      counts.skipped += 1;
      emit({ index, total, status: 'skipped', kind: 'collection', name, id: rec.id });
      continue;
    }
    logger.info(
      { name, id: rec.id, slug: rec.slug },
      `→ deleting collection "${name}" (id ${rec.id})${dryRun ? ' [dry-run]' : ''}`,
    );
    try {
      if (!dryRun) {
        await deleteCollection(client, rec.id, cfg.ghlLocationId);
        state.deleteCollection(name);
        await state.save();
      }
      counts.collectionsDeleted += 1;
      logger.info(
        { name, id: rec.id },
        `✓ collection deleted "${name}" (id ${rec.id})${dryRun ? ' [dry-run]' : ''}`,
      );
      index += 1;
      emit({ index, total, status: 'deleted', kind: 'collection', name, id: rec.id });
    } catch (err) {
      counts.collectionsFailed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { name, id: rec.id, err: msg },
        `✗ failed to delete collection "${name}": ${msg}`,
      );
      index += 1;
      emit({ index, total, status: 'failed', kind: 'collection', name, id: rec.id, error: msg });
    }
  }

  const durationMs = Date.now() - start;
  logger.info(
    { durationSec: (durationMs / 1000).toFixed(1), counts },
    `▼ wipe done — ${counts.productsDeleted} products, ${counts.collectionsDeleted} collections deleted${dryRun ? ' [dry-run]' : ''}`,
  );

  return { durationMs, dryRun, counts, outcomes };
}
