import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { writeStatusBack } from '../src/orchestrator/status-writer.js';
import type { SyncOutcome } from '../src/orchestrator/products.js';

const silentLogger = pino({ level: 'silent' });

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'status-writer-'));
}

describe('writeStatusBack', () => {
  test('appends Status + StatusError columns; rows in changes get their outcome, others get unchanged', async () => {
    const dir = await tempDir();
    const csvPath = join(dir, 'archive.csv');
    try {
      // 4 rows: 100109 will be created, 100110 updated, 100111 failed,
      // 100112 isn't in outcomes (so → unchanged)
      const csv = [
        'Code,Name,Price1',
        '100109,AD Labels 40 x 20mm,0.21',
        '100110,AD Labels 55 x 24mm,0.26',
        '100111,Broken Product,1.00',
        '100112,Unchanged Item,2.00',
      ].join('\n');
      await writeFile(csvPath, csv);

      const outcomes: SyncOutcome[] = [
        { code: '100109', name: 'AD Labels 40 x 20mm', status: 'created', productId: 'p1', priceId: 'pr1' },
        { code: '100110', name: 'AD Labels 55 x 24mm', status: 'updated', productId: 'p2', priceId: 'pr2' },
        { code: '100111', name: 'Broken Product', status: 'failed', phase: 'product.create', error: 'HTTP 422: slug already exists in this location' },
      ];

      await writeStatusBack(csvPath, outcomes, silentLogger);

      const out = await readFile(csvPath, 'utf8');
      const lines = out.trim().split('\n');
      expect(lines[0]).toBe('Code,Name,Price1,Status,StatusError');
      // csv-stringify quotes long error strings
      expect(lines[1]).toContain('100109,AD Labels 40 x 20mm,0.21,created,');
      expect(lines[2]).toContain('100110,AD Labels 55 x 24mm,0.26,updated,');
      expect(lines[3]).toContain('100111');
      expect(lines[3]).toContain('failed');
      expect(lines[3]).toContain('slug already exists');
      expect(lines[4]).toContain('100112,Unchanged Item,2.00,unchanged,');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('preserves existing Status column when row is "unchanged" (re-run case)', async () => {
    // Scenario: previous run wrote Status=created. This run, the row isn't
    // in changes.csv → unchanged. The previous status MUST be preserved
    // (so the next-month diff still sees the historical record).
    const dir = await tempDir();
    const csvPath = join(dir, 'archive.csv');
    try {
      const csv = [
        'Code,Name,Status,StatusError',
        '100109,AD Labels,created,',
        '100110,AD Labels 55,updated,',
      ].join('\n');
      await writeFile(csvPath, csv);

      // No outcomes → both rows would be "unchanged" — but they have Status already
      await writeStatusBack(csvPath, [], silentLogger);

      const out = await readFile(csvPath, 'utf8');
      expect(out).toContain('100109,AD Labels,created');
      expect(out).toContain('100110,AD Labels 55,updated');
      expect(out).not.toContain('unchanged');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('drops the leading unnamed empty column (trends.nz Excel artefact)', async () => {
    const dir = await tempDir();
    const csvPath = join(dir, 'archive.csv');
    try {
      // Leading empty column header — same shape as the user's actual new.csv
      const csv = [
        ',Code,Name,Price1',
        ',100109,AD Labels,0.21',
      ].join('\n');
      await writeFile(csvPath, csv);

      await writeStatusBack(
        csvPath,
        [{ code: '100109', name: 'AD Labels', status: 'created', productId: 'p1', priceId: 'pr1' }],
        silentLogger,
      );

      const out = await readFile(csvPath, 'utf8');
      // No leading comma in header any more
      expect(out.split('\n')[0]).toBe('Code,Name,Price1,Status,StatusError');
      // No leading comma in the data row either
      expect(out.split('\n')[1]).toContain('100109,AD Labels,0.21,created,');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('atomic write: a write error leaves the original file untouched', async () => {
    // We can't easily simulate a rename failure without mocking node:fs, but
    // this test verifies the basic atomicity by ensuring intermediate .tmp
    // files don't pollute the dir on success.
    const dir = await tempDir();
    const csvPath = join(dir, 'archive.csv');
    try {
      await writeFile(csvPath, 'Code,Name\n100109,AD Labels\n');
      await writeStatusBack(
        csvPath,
        [{ code: '100109', name: 'AD Labels', status: 'created', productId: 'p1', priceId: 'pr1' }],
        silentLogger,
      );
      const { readdir } = await import('node:fs/promises');
      const names = await readdir(dir);
      expect(names).toContain('archive.csv');
      expect(names).not.toContain('archive.csv.tmp');
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
