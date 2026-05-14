import { parse } from 'csv-parse';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { GhlClient } from '../ghl/client.js';
import { createPrice, updatePrice } from '../ghl/prices.js';
import {
  createProduct,
  findProductBySku,
  listProducts,
  SlugCollisionError,
  updateProduct,
} from '../ghl/products.js';
import { buildCreatePriceDto } from '../mapping/price.js';
import { buildCreateProductDto, CATEGORY_KEYS } from '../mapping/product.js';
import { slugify } from '../mapping/slugs.js';
import type { StateStore } from '../state.js';
import type { CollectionResolver } from './collection-resolver.js';
import { syncImagesForProduct } from './images.js';

export type SyncOutcomeStatus = 'created' | 'updated' | 'skipped' | 'recovered' | 'failed' | 'cancelled';

export type SyncOutcome =
  | { code: string; name: string; status: 'created'; productId: string; priceId: string }
  | { code: string; name: string; status: 'updated'; productId: string; priceId: string | null }
  | { code: string; name: string; status: 'skipped'; reason: string }
  | { code: string; name: string; status: 'recovered'; productId: string; priceId: string | null }
  | { code: string; name: string; status: 'failed'; phase: string; error: string }
  | { code: string; name: string; status: 'cancelled' };

export interface ProgressEvent {
  code: string;
  name: string;
  status: SyncOutcomeStatus;
  error?: string;
  index: number; // 1-based
  total: number;
}

export interface SyncProductsOpts {
  client: GhlClient;
  state: StateStore;
  locationId: string;
  currency: string;
  changesCsv: string;
  /** Resolves Category1..6 strings to GHL collection IDs, auto-creating missing ones. */
  resolver: CollectionResolver;
  logger: Logger;
  dryRun: boolean;
  /** Set true to allow product creation when state.json is empty AND GHL has products. */
  allowCreateWithoutState: boolean;
  /** Per-product concurrency. Default 4 — sized against GHL's 100 req/10s limit. */
  concurrency?: number;
  /** Called once per product after its outcome is known. Used by the UI for live progress. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Optional cancellation signal. When aborted, products that have already
   * started will finish; products not yet started will return as 'cancelled'
   * without touching GHL.
   */
  signal?: AbortSignal;
}

export interface SyncProductsResult {
  outcomes: SyncOutcome[];
  counts: {
    created: number;
    updated: number;
    skipped: number;
    recovered: number;
    failed: number;
    cancelled: number;
  };
}

export class OrphanRiskError extends Error {
  constructor() {
    super(
      'state.json is empty but GHL has existing products. Refusing to create products to avoid duplicates. ' +
        'Pass --allow-create-without-state to override (each unmatched product will be re-created and the old one orphaned).',
    );
    this.name = 'OrphanRiskError';
  }
}

const canonicalJson = (v: unknown): string => JSON.stringify(v, Object.keys(v as object).sort());
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

async function readChangesRows(csvPath: string): Promise<Record<string, string>[]> {
  const out: Record<string, string>[] = [];
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }),
  );
  for await (const row of parser) {
    out.push(row as Record<string, string>);
  }
  return out;
}

export async function syncProducts(opts: SyncProductsOpts): Promise<SyncProductsResult> {
  const {
    client,
    state,
    locationId,
    changesCsv,
    logger,
    dryRun,
    allowCreateWithoutState,
  } = opts;
  // currency, resolver are consumed inside syncOneProduct via opts.* — they're
  // intentionally not destructured here to keep the inner function simple.

  // Pre-flight orphan check (R14)
  if (!state.hasProducts() && !allowCreateWithoutState && !dryRun) {
    logger.info('state empty — checking GHL for existing products to detect orphan risk');
    const existing = await listProducts(client, { locationId, limit: 1 });
    if (existing.length > 0) {
      throw new OrphanRiskError();
    }
  }

  const rows = await readChangesRows(changesCsv);
  logger.info({ count: rows.length }, 'changes.csv loaded');

  const limit = pLimit(opts.concurrency ?? 4);
  const total = rows.length;
  let completed = 0;
  const outcomes: SyncOutcome[] = await Promise.all(
    rows.map((row) =>
      limit(async (): Promise<SyncOutcome> => {
        // Cancel check — runs the moment this row is dequeued from p-limit.
        // Products already in flight when cancel fires will keep running and
        // complete; products not yet dequeued return immediately as cancelled.
        if (opts.signal?.aborted) {
          return {
            code: (row.Code ?? '').trim(),
            name: (row.Name ?? '').trim(),
            status: 'cancelled',
          };
        }
        const outcome: SyncOutcome = await syncOneProduct(row, opts).catch(
          (err): SyncOutcome => ({
            code: row.Code ?? '',
            name: row.Name ?? '',
            status: 'failed',
            phase: 'orchestrate',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        completed += 1;
        if (opts.onProgress) {
          opts.onProgress({
            code: outcome.code,
            name: outcome.name,
            status: outcome.status,
            error: outcome.status === 'failed' ? outcome.error : undefined,
            index: completed,
            total,
          });
        }
        return outcome;
      }),
    ),
  );

  const counts = {
    created: outcomes.filter((o) => o.status === 'created').length,
    updated: outcomes.filter((o) => o.status === 'updated').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
    recovered: outcomes.filter((o) => o.status === 'recovered').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    cancelled: outcomes.filter((o) => o.status === 'cancelled').length,
  };

  return { outcomes, counts };
}

async function syncOneProduct(
  row: Record<string, string>,
  opts: SyncProductsOpts,
): Promise<SyncOutcome> {
  const { client, state, locationId, currency, resolver, logger, dryRun } = opts;
  const code = (row.Code ?? '').trim();
  const name = (row.Name ?? '').trim();
  if (!code) {
    return { code: '', name, status: 'failed', phase: 'parse', error: 'missing Code in row' };
  }

  const imageCount = parseInt(row.ImageCount ?? '0', 10) || 0;

  logger.info(
    { code, name, imageCount },
    `▶ processing product "${name}" (code ${code}, ${imageCount} image${imageCount === 1 ? '' : 's'} expected)`,
  );

  // 1. Images
  let mediaUrls: string[] = [];
  try {
    mediaUrls = await syncImagesForProduct({
      client,
      state,
      locationId,
      code,
      imageCount,
      logger,
      dryRun,
    });
  } catch (err) {
    return { code, name, status: 'failed', phase: 'images', error: err instanceof Error ? err.message : String(err) };
  }

  // 2. Build product DTO — resolve each category, auto-creating any that GHL
  // doesn't have yet. The resolver dedupes concurrent creates for the same name.
  const collectionIds: string[] = [];
  const unresolved: string[] = [];
  for (const key of CATEGORY_KEYS) {
    const cat = (row[key] ?? '').trim();
    if (!cat) continue;
    const id = await resolver.resolve(cat);
    if (id) collectionIds.push(id);
    else unresolved.push(cat);
  }
  if (unresolved.length > 0) {
    logger.warn(
      { code, unresolved },
      'some categories could not be created or found — product will be linked without them',
    );
  }
  const productDto = buildCreateProductDto(row, { locationId, mediaUrls, collectionIds });
  const priceDto = buildCreatePriceDto(row, { locationId, currency });

  const payloadSha = sha256(canonicalJson(productDto));
  const priceSha = sha256(canonicalJson(priceDto));

  const existing = state.getProduct(code);

  // 3. Skip path: nothing changed since last sync
  if (existing && existing.payloadSha === payloadSha && existing.priceSha === priceSha) {
    logger.info(
      { code, name, productId: existing.ghlProductId, priceId: existing.ghlPriceId },
      `· skipped "${name}" (code ${code}) — unchanged since last sync`,
    );
    return { code, name, status: 'skipped', reason: 'unchanged' };
  }

  // 4. Dry-run: don't touch GHL, but DO record the outcome to the dry-run state
  // file (which is separate from the real state.json — see pipeline.ts). This
  // way a stopped dry-run can resume from where the user paused.
  if (dryRun) {
    const outcome: SyncOutcome = existing
      ? { code, name, status: 'updated', productId: existing.ghlProductId, priceId: existing.ghlPriceId }
      : { code, name, status: 'created', productId: 'dry-run-product-id', priceId: 'dry-run-price-id' };
    state.setProduct(code, {
      ghlProductId: existing?.ghlProductId ?? 'dry-run-product-id',
      ghlPriceId: existing?.ghlPriceId ?? 'dry-run-price-id',
      payloadSha,
      priceSha,
      syncedAt: new Date().toISOString(),
    });
    await state.save();
    return outcome;
  }

  // 5. Resolve product id (state, recovery, or create)
  let productId: string;
  let priceId: string | null;
  let recovered = false;

  if (existing) {
    productId = existing.ghlProductId;
    priceId = existing.ghlPriceId;
  } else {
    // Try SKU recovery before creating
    try {
      const found = await findProductBySku(client, code, {
        locationId,
        productName: productDto.name,
      });
      if (found) {
        productId = found.productId;
        priceId = found.priceId;
        recovered = true;
        logger.info(
          { code, name: productDto.name, productId, priceId },
          '↺ product recovered by SKU (existing GHL product matched, state will be repaired)',
        );
      } else {
        // Create
        try {
          logger.info(
            { code, name: productDto.name, images: productDto.medias.length, categories: productDto.collectionIds.length },
            `→ creating product "${productDto.name}" (code ${code})`,
          );
          const created = await createProduct(client, productDto);
          productId = created.id;
          priceId = null;
          logger.info(
            {
              code,
              name: productDto.name,
              productId,
              images: productDto.medias.length,
              categories: productDto.collectionIds.length,
            },
            `✓ product created "${productDto.name}" (id ${productId})`,
          );
        } catch (err) {
          if (err instanceof SlugCollisionError) {
            // Retry with code-suffixed slug
            const retryDto = { ...productDto, slug: `${slugify(productDto.name)}-${code}` };
            logger.warn(
              { code, name: retryDto.name, slug: retryDto.slug },
              `↻ retrying create with suffixed slug "${retryDto.slug}" (slug collision)`,
            );
            const created = await createProduct(client, retryDto);
            productId = created.id;
            priceId = null;
            logger.info(
              {
                code,
                name: retryDto.name,
                slug: retryDto.slug,
                productId,
                images: retryDto.medias.length,
                categories: retryDto.collectionIds.length,
              },
              `✓ product created "${retryDto.name}" (id ${productId}, slug ${retryDto.slug})`,
            );
            // Update payloadSha because slug differs
            const newSha = sha256(canonicalJson(retryDto));
            state.setProduct(code, {
              ghlProductId: productId,
              ghlPriceId: null,
              payloadSha: newSha,
              priceSha: null,
              syncedAt: new Date().toISOString(),
            });
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      return { code, name, status: 'failed', phase: 'product.create', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 6. Update product if anything changed
  if (existing && existing.payloadSha !== payloadSha) {
    try {
      logger.info(
        { code, name: productDto.name, productId, images: productDto.medias.length, categories: productDto.collectionIds.length },
        `→ updating product "${productDto.name}" (id ${productId})`,
      );
      await updateProduct(client, productId, productDto);
      logger.info(
        {
          code,
          name: productDto.name,
          productId,
          images: productDto.medias.length,
          categories: productDto.collectionIds.length,
        },
        `↻ product updated "${productDto.name}" (id ${productId})`,
      );
    } catch (err) {
      return { code, name, status: 'failed', phase: 'product.update', error: err instanceof Error ? err.message : String(err) };
    }
  } else if (recovered) {
    // Recovered products: PUT to ensure GHL state matches our DTO
    try {
      logger.info(
        { code, name: productDto.name, productId },
        `→ repushing recovered product "${productDto.name}" (id ${productId})`,
      );
      await updateProduct(client, productId, productDto);
      logger.info(
        {
          code,
          name: productDto.name,
          productId,
          images: productDto.medias.length,
          categories: productDto.collectionIds.length,
        },
        `↻ product synced "${productDto.name}" (recovered → repushed, id ${productId})`,
      );
    } catch (err) {
      return { code, name, status: 'failed', phase: 'product.update.recovered', error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 7. Price: create or update
  try {
    if (!priceId) {
      logger.info(
        { code, name: productDto.name, productId, amount: priceDto.amount, currency: priceDto.currency },
        `→ creating price for "${productDto.name}" (productId ${productId}) — ${priceDto.currency} ${priceDto.amount.toFixed(2)}`,
      );
      const price = await createPrice(client, productId, priceDto);
      priceId = price.id;
      logger.info(
        {
          code,
          name: productDto.name,
          productId,
          priceId,
          amount: priceDto.amount,
          currency: priceDto.currency,
          sku: priceDto.sku,
          qty: priceDto.availableQuantity,
        },
        `✓ price created for "${productDto.name}" (priceId ${priceId}) — ${priceDto.currency} ${priceDto.amount.toFixed(2)}`,
      );
    } else if (!existing || existing.priceSha !== priceSha) {
      logger.info(
        { code, name: productDto.name, productId, priceId, amount: priceDto.amount, currency: priceDto.currency },
        `→ updating price for "${productDto.name}" (priceId ${priceId}) — ${priceDto.currency} ${priceDto.amount.toFixed(2)}`,
      );
      await updatePrice(client, productId, priceId, priceDto);
      logger.info(
        {
          code,
          name: productDto.name,
          productId,
          priceId,
          amount: priceDto.amount,
          currency: priceDto.currency,
          sku: priceDto.sku,
          qty: priceDto.availableQuantity,
        },
        `↻ price updated for "${productDto.name}" (priceId ${priceId}) — ${priceDto.currency} ${priceDto.amount.toFixed(2)}`,
      );
    }
  } catch (err) {
    // Persist what we have so far so we can resume
    state.setProduct(code, {
      ghlProductId: productId,
      ghlPriceId: priceId,
      payloadSha,
      priceSha: existing?.priceSha ?? null,
      syncedAt: new Date().toISOString(),
    });
    await state.save();
    return { code, name, status: 'failed', phase: 'price', error: err instanceof Error ? err.message : String(err) };
  }

  // 8. Persist final state
  state.setProduct(code, {
    ghlProductId: productId,
    ghlPriceId: priceId,
    payloadSha,
    priceSha,
    syncedAt: new Date().toISOString(),
  });
  await state.save();

  if (recovered) return { code, name, status: 'recovered', productId, priceId };
  if (existing) return { code, name, status: 'updated', productId, priceId };
  return { code, name, status: 'created', productId, priceId: priceId ?? '' };
}
