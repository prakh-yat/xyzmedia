import { parse } from 'csv-parse';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import { GhlClient } from './ghl/client.js';
import {
  createCollection,
  listCollections,
  MissingScopeError,
} from './ghl/collections.js';
import { uploadFile, MissingMediaScopeError } from './ghl/medias.js';
import { createPrice, listPrices } from './ghl/prices.js';
import { createProduct, getProduct } from './ghl/products.js';
import { buildCreatePriceDto } from './mapping/price.js';
import { buildCreateProductDto, resolveCollectionIds } from './mapping/product.js';
import type { Tokens } from './oauth/flow.js';
import { StateStore } from './state.js';
import { syncImagesForProduct } from './orchestrator/images.js';

const SMOKE_COLLECTION_NAME = '_xyz_smoke_DELETE_ME';
const SMOKE_COLLECTION_SLUG = 'xyz-smoke-delete-me';

// 1x1 transparent JPEG (smallest valid jpeg)
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z',
  'base64',
);

export interface RoundTripCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  runId: string;
  durationMs: number;
  ok: boolean;
  /** True when only the probes (collection+media scope) ran. */
  probesOnly?: boolean;
  probes: {
    collections: { ok: boolean; error?: string };
    medias: { ok: boolean; error?: string };
  };
  product: {
    code: string;
    name: string;
    productId: string;
    priceId: string;
    image: string;
    productUiUrl: string;
  } | null;
  roundTrip: RoundTripCheck[];
  error?: string;
}

export interface SmokeOpts {
  cfg: Config;
  logger: Logger;
  runId: string;
  /** Optional product Code from changes.csv to use; otherwise picks first NEW row. */
  code?: string;
  /** Optional CSV path override. Defaults to <dataDir>/changes.csv. */
  csvPath?: string;
}

/**
 * Runs the smoke test and returns a structured SmokeResult. Doesn't write to
 * stdout (the CLI wrapper does that). Used by both the CLI command and the
 * web UI's /api/smoke-one endpoint.
 */
export async function runSmoke(opts: SmokeOpts): Promise<SmokeResult> {
  const { cfg, logger } = opts;
  const start = Date.now();
  logger.info('=== smoke-one starting ===');

  const tokens: Tokens = JSON.parse(readFileSync(cfg.tokensFile, 'utf8'));
  const state = await StateStore.load(cfg.stateFile);

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

  const result: SmokeResult = {
    runId: opts.runId,
    durationMs: 0,
    ok: false,
    probes: {
      collections: { ok: false },
      medias: { ok: false },
    },
    product: null,
    roundTrip: [],
  };

  // === Probe 1: collection scope ===
  logger.info('probe 1/2: POST /products/collections (collection.write)');
  try {
    const collections = await listCollections(client, cfg.ghlLocationId);
    const existing = collections.find((c) => c.slug === SMOKE_COLLECTION_SLUG);
    if (existing) {
      logger.info({ id: existing.id }, '✓ collection scope OK (probe collection already existed)');
    } else {
      const created = await createCollection(client, {
        locationId: cfg.ghlLocationId,
        name: SMOKE_COLLECTION_NAME,
        slug: SMOKE_COLLECTION_SLUG,
      });
      logger.info({ id: created.id }, '✓ collection scope OK (probe collection created)');
    }
    result.probes.collections.ok = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.probes.collections.error = msg;
    if (err instanceof MissingScopeError) {
      result.error = msg;
      result.durationMs = Date.now() - start;
      return result;
    }
    result.error = `Collection probe failed: ${msg}`;
    result.durationMs = Date.now() - start;
    return result;
  }

  // === Probe 2: media scope ===
  logger.info('probe 2/2: POST /medias/upload-file (medias.write)');
  try {
    await uploadFile(client, {
      locationId: cfg.ghlLocationId,
      bytes: new Uint8Array(TINY_JPEG),
      filename: '_smoke_probe.jpg',
      contentType: 'image/jpeg',
    });
    logger.info('✓ media scope OK');
    result.probes.medias.ok = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.probes.medias.error = msg;
    if (err instanceof MissingMediaScopeError) {
      result.error = msg;
      result.durationMs = Date.now() - start;
      return result;
    }
    result.error = `Media probe failed: ${msg}`;
    result.durationMs = Date.now() - start;
    return result;
  }

  // === Single product end-to-end ===
  const csvPath = opts.csvPath ?? resolve(cfg.dataDir, 'changes.csv');
  const row = await pickRow(csvPath, opts.code);
  if (!row) {
    result.error = `No suitable row found in ${csvPath}${opts.code ? ` (code=${opts.code} not present)` : ''}`;
    result.probesOnly = true;
    result.ok = result.probes.collections.ok && result.probes.medias.ok;
    result.durationMs = Date.now() - start;
    return result;
  }

  logger.info({ code: row.Code, name: row.Name }, 'using row for smoke test');

  const allCollections = await listCollections(client, cfg.ghlLocationId);
  const nameToId = new Map<string, string>();
  for (const c of allCollections) nameToId.set(c.name, c.id);

  const imageCount = parseInt(row.ImageCount ?? '0', 10) || 0;
  const mediaUrls = await syncImagesForProduct({
    client,
    state,
    locationId: cfg.ghlLocationId,
    code: row.Code!,
    imageCount,
    logger,
    dryRun: false,
  });

  const { ids: collectionIds } = resolveCollectionIds(row, nameToId);
  const productDto = buildCreateProductDto(row, {
    locationId: cfg.ghlLocationId,
    mediaUrls,
    collectionIds,
  });
  const priceDto = buildCreatePriceDto(row, {
    locationId: cfg.ghlLocationId,
    currency: cfg.ghlCurrency,
  });

  logger.info({ name: productDto.name, mediaCount: productDto.medias.length }, 'creating product');
  const product = await createProduct(client, productDto);
  logger.info({ productId: product.id }, '✓ product created');

  const price = await createPrice(client, product.id, priceDto);
  logger.info({ priceId: price.id, amount: price.amount, currency: price.currency }, '✓ price created');

  // === Round-trip verification (R7) ===
  logger.info('round-trip GET to verify');
  const reloaded = await getProduct(client, product.id, cfg.ghlLocationId);
  if (!reloaded) {
    result.error = 'Product GET returned null after create';
    result.durationMs = Date.now() - start;
    return result;
  }

  result.roundTrip.push({
    name: 'image is non-empty',
    ok: !!reloaded.image && reloaded.image.length > 0,
    detail: reloaded.image ?? '(empty)',
  });
  result.roundTrip.push({
    name: 'medias[] count matches what we sent',
    ok: (reloaded.medias?.length ?? 0) === productDto.medias.length,
    detail: `sent ${productDto.medias.length}, got back ${reloaded.medias?.length ?? 0}`,
  });

  const reloadedPrices = await listPrices(client, product.id, cfg.ghlLocationId);
  const rp = reloadedPrices.find((p) => p.id === price.id) ?? reloadedPrices[0];
  if (rp) {
    result.roundTrip.push({
      name: `price amount echoes ${priceDto.amount}`,
      ok: Math.abs(rp.amount - priceDto.amount) < 0.001,
      detail: `expected ${priceDto.amount}, got ${rp.amount}`,
    });
    result.roundTrip.push({
      name: `price currency is ${cfg.ghlCurrency}`,
      ok: rp.currency === cfg.ghlCurrency,
      detail: `got ${rp.currency}`,
    });
  } else {
    result.roundTrip.push({ name: 'price reload', ok: false, detail: 'no price returned' });
  }

  result.product = {
    code: row.Code ?? '',
    name: productDto.name,
    productId: product.id,
    priceId: price.id,
    image: reloaded.image ?? '',
    productUiUrl: `https://app.gohighlevel.com/v2/location/${cfg.ghlLocationId}/payments/products`,
  };
  result.ok =
    result.probes.collections.ok &&
    result.probes.medias.ok &&
    result.roundTrip.every((c) => c.ok);
  result.durationMs = Date.now() - start;
  logger.info({ ok: result.ok, durationMs: result.durationMs }, `=== smoke-one ${result.ok ? 'PASSED' : 'FAILED'} ===`);
  return result;
}

/**
 * CLI entrypoint — runs runSmoke and pretty-prints to stdout.
 */
export async function runSmokeOne(opts: SmokeOpts): Promise<void> {
  const result = await runSmoke(opts);

  console.log('\n=== Pre-flight probes ===');
  console.log(`  ${sym(result.probes.collections.ok)} collection.write — ${result.probes.collections.error ?? 'OK'}`);
  console.log(`  ${sym(result.probes.medias.ok)} medias.write — ${result.probes.medias.error ?? 'OK'}`);

  if (result.roundTrip.length > 0) {
    console.log('\n=== Round-trip checks ===');
    for (const c of result.roundTrip) {
      console.log(`  ${sym(c.ok)} ${c.name}: ${c.detail}`);
    }
  }

  if (result.product) {
    console.log('\n=== Smoke product details ===');
    console.log(`  Code:        ${result.product.code}`);
    console.log(`  Product ID:  ${result.product.productId}`);
    console.log(`  Price ID:    ${result.product.priceId}`);
    console.log(`  Image:       ${result.product.image || '(none)'}`);
    console.log(`  Verify in GHL UI: ${result.product.productUiUrl}`);
    console.log('\nDelete this smoke product manually when done.');
  }

  if (result.error) {
    throw new Error(result.error);
  }
  if (!result.ok) {
    throw new Error('Smoke test verification failed — see checks above');
  }
}

function sym(ok: boolean): string {
  return ok ? '✓' : '✗';
}

async function pickRow(
  csvPath: string,
  preferredCode?: string,
): Promise<Record<string, string> | null> {
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true, bom: true }),
  );
  let firstNew: Record<string, string> | null = null;
  let firstAny: Record<string, string> | null = null;
  for await (const row of parser) {
    const r = row as Record<string, string>;
    if (preferredCode && r.Code === preferredCode) return r;
    if (!firstNew && r.ChangeType === 'NEW') firstNew = r;
    if (!firstAny && r.Code) firstAny = r;
  }
  // Prefer NEW (so we exercise the create path); fall back to any row.
  return firstNew ?? firstAny;
}
