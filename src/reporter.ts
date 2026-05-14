import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'csv-stringify/sync';
import type { SyncCollectionsResult } from './orchestrator/collections.js';
import type { SyncOutcome, SyncProductsResult } from './orchestrator/products.js';

export interface ReportInputs {
  runId: string;
  reportDir: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  /** Name of the new csv (e.g. "May_2026.csv") — needed for revert. */
  newFile?: string;
  /** Name of the old/baseline csv (e.g. "October_2025.csv") — needed to restore updated rows during revert. */
  oldFile?: string;
  collections: SyncCollectionsResult;
  products: SyncProductsResult;
  /** Collections we auto-created during the products phase (via the resolver). */
  autoCreatedCollections?: Array<{ name: string; id: string; slug: string }>;
  ghlDailyRemaining: number;
}

export interface ReportPaths {
  summaryJson: string;
  deadLetterCsv: string;
  changelogJson: string;
}

export function writeReport(inp: ReportInputs): ReportPaths {
  mkdirSync(inp.reportDir, { recursive: true });

  const summaryPath = join(inp.reportDir, `summary-${inp.runId}.json`);
  const summary = {
    runId: inp.runId,
    startedAt: inp.startedAt,
    finishedAt: inp.finishedAt,
    durationMs: inp.durationMs,
    dryRun: inp.dryRun,
    newFile: inp.newFile,
    oldFile: inp.oldFile,
    collections: {
      added: inp.collections.added.length,
      alreadyPresent: inp.collections.alreadyPresent.length,
      failed: inp.collections.failed.length,
      addedNames: inp.collections.added.map((c) => c.name),
      failedNames: inp.collections.failed,
    },
    products: inp.products.counts,
    ghlDailyRemaining: inp.ghlDailyRemaining,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  const deadLetterPath = join(inp.reportDir, `dead-letter-${inp.runId}.csv`);
  const failures = inp.products.outcomes.filter(
    (o): o is Extract<SyncOutcome, { status: 'failed' }> => o.status === 'failed',
  );
  const rows = [
    ['Code', 'Phase', 'Error'],
    ...failures.map((f) => [f.code, f.phase, f.error]),
    ...inp.collections.failed.map((f) => [f.name, 'collection.create', f.error]),
  ];
  writeFileSync(deadLetterPath, stringify(rows));

  // ---- Changelog: per-product detail so a future revert can undo this run ----
  // Drives the /api/runs/:runId/revert endpoint. Skipped for dry runs (nothing
  // to revert) and for empty result sets (avoids a bunch of empty files).
  const changelogPath = join(inp.reportDir, `changelog-${inp.runId}.json`);
  const created: Array<{ code: string; name: string; productId: string; priceId: string }> = [];
  const updated: Array<{ code: string; name: string; productId: string; priceId: string | null }> = [];
  const recovered: Array<{ code: string; name: string; productId: string; priceId: string | null }> = [];
  for (const o of inp.products.outcomes) {
    if (o.status === 'created') created.push({ code: o.code, name: o.name, productId: o.productId, priceId: o.priceId });
    else if (o.status === 'updated') updated.push({ code: o.code, name: o.name, productId: o.productId, priceId: o.priceId ?? null });
    else if (o.status === 'recovered') recovered.push({ code: o.code, name: o.name, productId: o.productId, priceId: o.priceId ?? null });
  }
  // Collections come from two places — both now carry {name, id, slug}.
  // Revert deletes the union (deduped by id) AFTER restoring updated products.
  const addedDiff = inp.collections.added; // [{name,id,slug}]
  const addedAuto = (inp.autoCreatedCollections ?? []).map((c) => ({
    name: c.name,
    id: c.id,
    slug: c.slug,
  }));
  const addedById = new Map<string, { name: string; id: string; slug: string }>();
  for (const c of [...addedDiff, ...addedAuto]) {
    if (c.id && c.id !== 'dry-run-id') addedById.set(c.id, c);
  }
  const changelog = {
    runId: inp.runId,
    startedAt: inp.startedAt,
    finishedAt: inp.finishedAt,
    dryRun: inp.dryRun,
    newFile: inp.newFile,
    oldFile: inp.oldFile,
    products: { created, updated, recovered },
    collections: {
      addedByDiff: addedDiff,
      autoCreated: addedAuto,
      /** Deduped union of all collections created during this run — the revert target. */
      addedAll: Array.from(addedById.values()),
    },
  };
  writeFileSync(changelogPath, JSON.stringify(changelog, null, 2));

  return { summaryJson: summaryPath, deadLetterCsv: deadLetterPath, changelogJson: changelogPath };
}

export function totalFailureCount(rep: { collections: SyncCollectionsResult; products: SyncProductsResult }): number {
  return rep.collections.failed.length + rep.products.counts.failed;
}
