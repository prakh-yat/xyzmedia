/**
 * Reconcile state.json with the live GHL store.
 *
 * Problem: state.json.products is empty but GHL already has products, so a
 * normal sync would refuse to run (OrphanRiskError) to avoid creating duplicates.
 *
 * This script lists every product in GHL, fetches each product's prices to get
 * the SKU (= our CSV `Code` column), and writes one entry per matched SKU into
 * state.products with the real ghlProductId/ghlPriceId. Existing `medias` and
 * `collections` in state.json are preserved.
 *
 * Shas are left blank so the next sync will treat every existing product as
 * "needs update" and PUT it once (idempotent). After that first sync, shas are
 * correct and subsequent syncs run normally.
 *
 * Run with:  npx tsx src/reconcile.ts
 */
import { readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { loadConfig } from './config.js';
import { GhlClient } from './ghl/client.js';
import { listPrices } from './ghl/prices.js';
import { listProducts } from './ghl/products.js';
import { createLogger, newRunId } from './logger.js';
import type { Tokens } from './oauth/flow.js';
import { StateStore, type ProductRecord } from './state.js';

const PAGE_SIZE = 100;
const PRICE_FETCH_CONCURRENCY = 4;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const runId = newRunId();
  const logger = createLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });

  logger.info({ runId, locationId: cfg.ghlLocationId }, 'reconcile: starting');

  const tokensRaw = await readFile(cfg.tokensFile, 'utf8');
  const tokens: Tokens = JSON.parse(tokensRaw);

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
      const tmp = `${cfg.tokensFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, cfg.tokensFile);
    },
    logger,
  });

  // 1. Back up the current state file so the operation is reversible.
  const backupPath = `${cfg.stateFile}.before-reconcile-${runId}`;
  try {
    await copyFile(cfg.stateFile, backupPath);
    logger.info({ backupPath }, 'reconcile: backed up existing state');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
    logger.info('reconcile: no existing state.json to back up');
  }

  // 2. Load existing state — we keep its medias/collections and only overwrite products.
  const state = await StateStore.load(cfg.stateFile);
  logger.info(
    { existingProducts: state.productCount(), existingCollections: state.collectionNames().length },
    'reconcile: loaded existing state',
  );

  // 3. Page through every product in GHL.
  const products: Array<{ id: string; name: string }> = [];
  let offset = 0;
  while (true) {
    const page = await listProducts(client, {
      locationId: cfg.ghlLocationId,
      limit: PAGE_SIZE,
      offset,
    });
    if (page.length === 0) break;
    for (const p of page) products.push({ id: p.id, name: p.name });
    logger.info({ fetched: products.length }, 'reconcile: listing products');
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  logger.info({ total: products.length }, 'reconcile: finished listing GHL products');

  // 4. For each product, fetch its prices to extract the SKU. Concurrency is
  // capped client-side; the GhlClient's token bucket throttles to 10 req/sec.
  const limit = pLimit(PRICE_FETCH_CONCURRENCY);
  let done = 0;
  const noSku: Array<{ id: string; name: string }> = [];
  const multiSku: Array<{ id: string; name: string; skus: string[] }> = [];
  const skuToRecord = new Map<string, ProductRecord>();
  const collisions: Array<{ sku: string; existingProductId: string; newProductId: string }> = [];

  const now = new Date().toISOString();

  await Promise.all(
    products.map((p) =>
      limit(async () => {
        try {
          const prices = await listPrices(client, p.id, cfg.ghlLocationId);
          const withSku = prices.filter((pr) => pr.sku && pr.sku.trim() !== '');
          if (withSku.length === 0) {
            noSku.push({ id: p.id, name: p.name });
            return;
          }
          if (withSku.length > 1) {
            multiSku.push({ id: p.id, name: p.name, skus: withSku.map((s) => s.sku) });
          }
          // First price with a SKU wins (matches what the sync code does — one product : one price).
          const winning = withSku[0]!;
          const sku = winning.sku.trim();

          if (skuToRecord.has(sku)) {
            collisions.push({
              sku,
              existingProductId: skuToRecord.get(sku)!.ghlProductId,
              newProductId: p.id,
            });
          }
          skuToRecord.set(sku, {
            ghlProductId: p.id,
            ghlPriceId: winning.id,
            payloadSha: '', // blank → next sync will PUT this product once
            priceSha: null, // blank → next sync will PUT this price once
            syncedAt: now,
          });
        } catch (err) {
          logger.warn(
            { productId: p.id, name: p.name, err: err instanceof Error ? err.message : String(err) },
            'reconcile: failed to fetch prices for product (skipping)',
          );
        } finally {
          done += 1;
          if (done % 100 === 0 || done === products.length) {
            logger.info({ done, total: products.length }, 'reconcile: fetched prices');
          }
        }
      }),
    ),
  );

  // 5. Merge into state.
  for (const [sku, rec] of skuToRecord) {
    state.setProduct(sku, rec);
  }
  await state.save();

  logger.info(
    {
      productsListed: products.length,
      matchedToSku: skuToRecord.size,
      noSku: noSku.length,
      multiSku: multiSku.length,
      skuCollisions: collisions.length,
      stateFile: cfg.stateFile,
      backupPath,
    },
    '=== reconcile complete ===',
  );

  if (noSku.length > 0) {
    logger.warn(
      { count: noSku.length, sample: noSku.slice(0, 10) },
      'reconcile: products in GHL with no price SKU — these will not match any CSV row',
    );
  }
  if (multiSku.length > 0) {
    logger.warn(
      { count: multiSku.length, sample: multiSku.slice(0, 10) },
      'reconcile: products with multiple priced SKUs — used the first one with a SKU',
    );
  }
  if (collisions.length > 0) {
    logger.warn(
      { count: collisions.length, sample: collisions.slice(0, 10) },
      'reconcile: duplicate SKUs across multiple GHL products — last one wins. Manual review recommended',
    );
  }

  console.log(`\n✓ reconcile complete`);
  console.log(`  GHL products listed:     ${products.length}`);
  console.log(`  matched to state by SKU: ${skuToRecord.size}`);
  console.log(`  no SKU (skipped):        ${noSku.length}`);
  console.log(`  multi-SKU (took first):  ${multiSku.length}`);
  console.log(`  SKU collisions:          ${collisions.length}`);
  console.log(`  state.json updated.      backup: ${backupPath}`);
  console.log(`\nYou can now click "Run Sync" in the web UI.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
