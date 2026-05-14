import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { runDiffs } from '../diff-runner.js';
import { GhlClient } from '../ghl/client.js';
import { listCollectionsRaw } from '../ghl/collections.js';
import { type Notifier } from '../notify.js';
import type { Tokens } from '../oauth/flow.js';
import { totalFailureCount, writeReport } from '../reporter.js';
import { StateStore } from '../state.js';
import { CollectionResolver } from './collection-resolver.js';
import { syncCollections } from './collections.js';
import { syncProducts, type ProgressEvent } from './products.js';
import { writeStatusBack } from './status-writer.js';

export interface PipelineOpts {
  cfg: Config;
  logger: Logger;
  runId: string;
  notifier: Notifier;
  dryRun?: boolean;
  allowCreateWithoutState?: boolean;
  /** Skip running the python diff scripts (e.g., if changes.csv is already there). */
  skipDiff?: boolean;
  /** Per-product progress callback used by the web UI for live updates. */
  onProgress?: (event: ProgressEvent) => void;
  /**
   * Path to the original archived CSV that became the "new" file for this run.
   * If set, after sync completes the orchestrator writes a Status column back
   * to this file (so the user can see per-row outcomes in the archive).
   */
  archiveNewCsvPath?: string;
  /**
   * Archive filenames (basename only, e.g. "May_2026.csv") for this run.
   * Persisted in the changelog so a future revert can find the old baseline
   * needed to restore updated products.
   */
  newFileName?: string;
  oldFileName?: string;
  /**
   * Cancellation signal. When aborted mid-run, in-flight products finish but
   * not-yet-started products are marked as 'cancelled' and skipped. The state
   * file still gets updated for everything that completed, so re-running picks
   * up where the user left off.
   */
  signal?: AbortSignal;
}

export async function runSync(opts: PipelineOpts): Promise<void> {
  const { cfg, logger, runId, notifier } = opts;
  const dryRun = opts.dryRun ?? cfg.dryRun;
  const startedAt = new Date().toISOString();
  const start = Date.now();

  logger.info({ dryRun, runId }, 'starting sync');

  // 1. Load tokens
  const tokens = await loadTokens(cfg.tokensFile);
  logger.info({ locationId: tokens.locationId, expiresAt: new Date(tokens.expiresAt).toISOString() }, 'loaded tokens');

  // 2. Build state + GHL client.
  // Dry-runs use a SEPARATE state file so they (a) can resume after a stop
  // without touching the real state, and (b) never falsely mark a product as
  // "synced to GHL" when nothing was actually pushed.
  const stateFilePath = dryRun ? cfg.stateDryRunFile : cfg.stateFile;
  logger.info({ stateFile: stateFilePath, dryRun }, 'loading state');
  const state = await StateStore.load(stateFilePath);
  const client = new GhlClient({
    baseUrl: cfg.ghlBaseUrl,
    apiVersion: cfg.ghlApiVersion,
    oauth: {
      clientId: cfg.ghlClientId,
      clientSecret: cfg.ghlClientSecret,
      redirectUri: cfg.ghlRedirectUri,
    },
    tokens,
    persistTokens: async (newTokens: Tokens) => {
      const { writeFile, rename, chmod } = await import('node:fs/promises');
      const tmp = `${cfg.tokensFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(newTokens, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, cfg.tokensFile);
      await chmod(cfg.tokensFile, 0o600).catch(() => {});
    },
    logger,
  });

  // 3. Run diff scripts (unless skipped)
  let changesCsv: string;
  let categoryChangesCsv: string;
  if (opts.skipDiff) {
    changesCsv = resolve(cfg.dataDir, 'changes.csv');
    categoryChangesCsv = resolve(cfg.dataDir, 'category_changes.csv');
  } else {
    const diff = await runDiffs({
      dataDir: cfg.dataDir,
      pythonBin: cfg.pythonBin,
      scriptsDir: '.', // diff_csv.py and diff_categories.py at project root
      logger,
    });
    changesCsv = diff.changesCsv;
    categoryChangesCsv = diff.categoryChangesCsv;
  }

  // 4. Collections phase
  logger.info('--- collections phase ---');
  const collections = await syncCollections({
    client,
    state,
    locationId: cfg.ghlLocationId,
    categoryChangesCsv,
    logger,
    dryRun,
  });
  logger.info({ added: collections.added.length, alreadyPresent: collections.alreadyPresent.length }, 'collections phase done');

  // 4b. Build the resolver — it owns the name->id map and auto-creates any
  // category that's referenced by a product but missing in GHL (e.g. categories
  // that were UNCHANGED in the diff but somehow not yet in the GHL store).
  const resolver = new CollectionResolver(
    collections.nameToId,
    state,
    client,
    cfg.ghlLocationId,
    logger,
    dryRun,
  );

  // 5. Products phase
  logger.info('--- products phase ---');
  const products = await syncProducts({
    client,
    state,
    locationId: cfg.ghlLocationId,
    currency: cfg.ghlCurrency,
    changesCsv,
    resolver,
    logger,
    dryRun,
    allowCreateWithoutState: opts.allowCreateWithoutState ?? false,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
  const autoCreatedCollections = resolver.getCreated();
  logger.info(
    { ...products.counts, autoCreatedCollections: autoCreatedCollections.length },
    'products phase done',
  );
  if (autoCreatedCollections.length > 0) {
    logger.info(
      { count: autoCreatedCollections.length, names: autoCreatedCollections.map((c) => c.name) },
      'auto-created collections during product sync',
    );
  }

  // 5b. Write Status column back to the archived CSV (the user-facing record)
  if (opts.archiveNewCsvPath && !dryRun && existsSync(opts.archiveNewCsvPath)) {
    try {
      await writeStatusBack(opts.archiveNewCsvPath, products.outcomes, logger);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'status writeback failed (non-fatal)');
    }
  }

  // 5c. Refresh collections.json so it stays a faithful snapshot of the GHL
  // store. Skipped for dry-run (no real changes happened in GHL).
  if (!dryRun) {
    try {
      const allRaw = await listCollectionsRaw(client, cfg.ghlLocationId);
      const path = cfg.collectionsJsonFile;
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(allRaw, null, 2));
      await rename(tmp, path);
      logger.info({ path, count: allRaw.length }, 'collections.json refreshed');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'collections.json refresh failed (non-fatal)');
    }
  }

  // 6. Report + notify
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - start;
  const paths = writeReport({
    runId,
    reportDir: cfg.reportDir,
    startedAt,
    finishedAt,
    durationMs,
    dryRun,
    newFile: opts.newFileName,
    oldFile: opts.oldFileName,
    collections,
    products,
    autoCreatedCollections,
    ghlDailyRemaining: client.getDailyRemaining(),
  });
  logger.info(
    { summary: paths.summaryJson, deadLetter: paths.deadLetterCsv, changelog: paths.changelogJson },
    'report written',
  );
  if (!dryRun) {
    logger.info(
      { changelog: paths.changelogJson, created: products.counts.created, updated: products.counts.updated },
      `📝 changelog saved — this run is now revertable from the Trends UI`,
    );
  }

  const failures = totalFailureCount({ collections, products });
  if (failures > 0) {
    await notifier.notify({
      runId,
      failureCount: failures,
      collectionsAdded: collections.added.length,
      productsCreated: products.counts.created,
      productsUpdated: products.counts.updated,
      productsSkipped: products.counts.skipped,
      productsFailed: products.counts.failed,
      durationMs,
      summaryPath: paths.summaryJson,
      deadLetterPath: paths.deadLetterCsv,
      logPath: `${cfg.logDir}/sync-${runId}.jsonl`,
    });
  }

  logger.info(
    {
      durationSec: (durationMs / 1000).toFixed(1),
      counts: products.counts,
      collections: { added: collections.added.length, alreadyPresent: collections.alreadyPresent.length },
      failures,
    },
    'sync done',
  );
}

async function loadTokens(path: string): Promise<Tokens> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') {
      throw new Error(
        `Tokens file ${path} not found. Run \`npm run oauth-setup\` first to authorize the integration.`,
      );
    }
    throw err;
  }
  return JSON.parse(raw) as Tokens;
}
