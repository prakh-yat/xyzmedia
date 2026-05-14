import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { SyncOutcome } from './products.js';

/**
 * After a sync run, write per-row status back into the archived "new" CSV file
 * as a `Status` column.
 *
 * Why: gives the user visibility into what was done, doubles as a re-run
 * marker (rows with empty/failed Status get re-tried), and survives loss of
 * state.json. The diff scripts ignore columns that exist on only one side, so
 * this added column won't cause false diffs next month.
 *
 * Status values:
 *   - "created"   — new product successfully created in GHL
 *   - "updated"   — existing product successfully updated
 *   - "recovered" — existing product matched by SKU after state loss
 *   - "skipped"   — payloadSha matched, no GHL writes needed
 *   - "unchanged" — row was not in changes.csv (no diff vs old file)
 *   - "failed"    — error during sync; first 200 chars of error preserved in StatusError
 *   - ""          — row was never processed (e.g. process killed mid-run)
 */
export async function writeStatusBack(
  archiveCsvPath: string,
  outcomes: SyncOutcome[],
  logger: Logger,
): Promise<void> {
  // Build a code → outcome map for fast lookup
  const byCode = new Map<string, SyncOutcome>();
  for (const o of outcomes) {
    if (o.code) byCode.set(o.code, o);
  }

  const raw = await readFile(archiveCsvPath, 'utf8');
  const records = parse(raw, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    logger.warn({ archiveCsvPath }, 'archive CSV had no rows; skipping status writeback');
    return;
  }

  const firstRow = records[0];
  if (!firstRow) return;

  // Build the column list. Preserve the original column order, ensure Status
  // and StatusError exist at the end.
  const baseCols = Object.keys(firstRow).filter((c) => c !== 'Status' && c !== 'StatusError');
  // Drop the leading unnamed column (excel artefact in trends.nz CSVs) cleanly
  const cleanedBaseCols = baseCols.filter((c) => c.trim().length > 0);
  const cols = [...cleanedBaseCols, 'Status', 'StatusError'];

  let updated = 0;
  for (const row of records) {
    const code = (row.Code ?? '').trim();
    const outcome = byCode.get(code);
    if (outcome) {
      if (outcome.status === 'cancelled') {
        // Cancelled rows didn't run — leave Status empty so the NEXT sync run
        // picks them up. If the row had a prior successful Status (e.g.
        // "created" from a previous run), preserve it.
        if (!row.Status) {
          row.Status = '';
          row.StatusError = '';
        }
      } else {
        row.Status = outcome.status;
        if (outcome.status === 'failed') {
          row.StatusError = (outcome.error ?? '').replace(/\n/g, ' ').slice(0, 200);
        } else {
          row.StatusError = '';
        }
        updated += 1;
      }
    } else {
      // Row was not in changes.csv → unchanged vs old.csv
      // Only mark unchanged if Status isn't already set from a prior run
      if (!row.Status) {
        row.Status = 'unchanged';
        row.StatusError = '';
      }
    }
  }

  // Drop any leading empty-named field on each row (the trends.nz Excel artefact)
  for (const row of records) {
    for (const k of Object.keys(row)) {
      if (k.trim().length === 0) delete row[k];
    }
  }

  const out = stringify(records, { header: true, columns: cols });
  // Atomic write: tmp + rename
  const tmp = `${archiveCsvPath}.tmp`;
  await writeFile(tmp, out, { mode: 0o644 });
  await rename(tmp, archiveCsvPath);

  logger.info({ archiveCsvPath, updated, total: records.length }, 'wrote Status back to archive csv');
}
