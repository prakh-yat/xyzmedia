import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { chmod, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { parse } from 'csv-parse';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { newRunId } from '../logger.js';
import { createNotifier } from '../notify.js';
import { runSync } from '../orchestrator/pipeline.js';
import { runRevert } from '../orchestrator/revert.js';
import { runWipe } from '../orchestrator/wipe.js';
import { runSmoke } from '../smoke.js';
import { createWebLogger } from './log-stream.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static');
const ARCHIVE_DIR = resolve(process.env.ARCHIVE_DIR ?? './archive');
const ROOT_DIR = resolve(process.env.DATA_DIR ?? '.');

const VALID_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const UploadSchema = z.object({
  month: z.enum([
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]),
  year: z.string().regex(/^\d{4}$/),
});

const SyncRequestSchema = z.object({
  newFile: z.string().regex(/^[A-Za-z]+_\d{4}\.csv$/),
  oldFile: z.string().regex(/^[A-Za-z]+_\d{4}\.csv$/),
  dryRun: z.boolean().optional().default(false),
  allowCreateWithoutState: z.boolean().optional().default(false),
});

const CancelRequestSchema = z.object({
  runId: z.string().min(1),
});

const SmokeRequestSchema = z.object({
  newFile: z.string().regex(/^[A-Za-z]+_\d{4}\.csv$/),
  /** Optional product Code to test; otherwise picks the first NEW row in the file. */
  code: z.string().optional(),
});

const TokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
  locationId: z.string().min(1),
});

/**
 * Track active sync runs so /api/sync/cancel can abort them. Each entry is the
 * AbortController for one in-flight /api/sync request. Cleared when the SSE
 * stream ends (success, failure, or cancellation).
 */
const activeRuns = new Map<string, AbortController>();

interface ArchiveEntry {
  name: string;
  size: number;
  mtime: string;
  month: string;
  year: string;
  rows: number | null;
}

async function countCsvRows(path: string): Promise<number | null> {
  // Use csv-parse in streaming mode so embedded newlines inside quoted fields
  // (very common in the trends.nz description column) don't inflate the count.
  return new Promise((resolve) => {
    let count = 0;
    const stream = createReadStream(path);
    const parser = stream.pipe(
      parse({ skip_empty_lines: true, relax_column_count: true, bom: true, columns: false }),
    );
    parser.on('data', () => {
      count += 1;
    });
    parser.on('end', () => {
      // Subtract header row
      resolve(Math.max(0, count - 1));
    });
    parser.on('error', () => resolve(null));
    stream.on('error', () => resolve(null));
  });
}

async function listArchive(): Promise<ArchiveEntry[]> {
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const names = await readdir(ARCHIVE_DIR);
  const out: ArchiveEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.csv')) continue;
    const m = /^([A-Za-z]+)_(\d{4})\.csv$/.exec(name);
    if (!m) continue;
    const fullPath = join(ARCHIVE_DIR, name);
    const st = await stat(fullPath);
    const rows = await countCsvRows(fullPath);
    out.push({
      name,
      size: st.size,
      mtime: st.mtime.toISOString(),
      month: m[1] as string,
      year: m[2] as string,
      rows,
    });
  }
  out.sort((a, b) => {
    const am = VALID_MONTHS.indexOf(a.month);
    const bm = VALID_MONTHS.indexOf(b.month);
    if (a.year !== b.year) return Number(b.year) - Number(a.year);
    return bm - am;
  });
  return out;
}

/**
 * HTTP Basic auth middleware. Enabled when both WEB_AUTH_USER and WEB_AUTH_PASS
 * are set in env. Otherwise the app runs unauthenticated (local-dev convenience).
 * Uses constant-time comparison to defeat timing attacks.
 */
function basicAuthMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
  const expectedUser = process.env.WEB_AUTH_USER ?? '';
  const expectedPass = process.env.WEB_AUTH_PASS ?? '';
  const enabled = expectedUser.length > 0 && expectedPass.length > 0;

  if (!enabled) {
    console.warn(
      '⚠  WEB_AUTH_USER / WEB_AUTH_PASS not set — UI is UNAUTHENTICATED.\n' +
        '   Set both in .env to enable HTTP Basic auth.',
    );
    return (_req, _res, next) => next();
  }

  const realm = 'xyz-sync';
  const userBuf = Buffer.from(expectedUser, 'utf8');
  const passBuf = Buffer.from(expectedPass, 'utf8');

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
      res.status(401).send('Authentication required');
      return;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      res.set('WWW-Authenticate', `Basic realm="${realm}"`);
      res.status(401).send('Invalid Authorization header');
      return;
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) {
      res.set('WWW-Authenticate', `Basic realm="${realm}"`);
      res.status(401).send('Invalid credentials format');
      return;
    }
    const gotUser = Buffer.from(decoded.slice(0, colon), 'utf8');
    const gotPass = Buffer.from(decoded.slice(colon + 1), 'utf8');

    const userOk = gotUser.length === userBuf.length && timingSafeEqual(gotUser, userBuf);
    const passOk = gotPass.length === passBuf.length && timingSafeEqual(gotPass, passBuf);
    if (!userOk || !passOk) {
      res.set('WWW-Authenticate', `Basic realm="${realm}"`);
      res.status(401).send('Invalid credentials');
      return;
    }
    next();
  };
}

export function buildApp() {
  const app = express();
  app.use(basicAuthMiddleware());
  app.use(express.json());

  // Multer with disk storage straight into archive/ — but with a temp name first,
  // because Node multer writes the file BEFORE the `month`/`year` body fields
  // are available on req.body for some content types. We stage to /tmp and rename.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB cap (CSVs are 2-3 MB)
  });

  // Static files
  app.use(express.static(STATIC_DIR));

  // ---------- API ----------

  app.get('/api/status', async (_req: Request, res: Response) => {
    let oauthOk = false;
    try {
      const cfg = loadConfig();
      oauthOk = existsSync(cfg.tokensFile);
    } catch {
      oauthOk = false;
    }
    res.json({ oauthOk });
  });

  // Upload a fresh tokens.json. Used after `npm run oauth-setup` locally to
  // seed the volume on Railway without SSH. Sits behind the same Basic Auth
  // as the rest of the dashboard.
  app.post('/api/tokens', async (req: Request, res: Response) => {
    const parsed = TokensSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid tokens.json shape — expected { accessToken, refreshToken, expiresAt, locationId }',
        details: parsed.error.flatten(),
      });
      return;
    }
    try {
      const cfg = loadConfig();
      await mkdir(dirname(cfg.tokensFile), { recursive: true }).catch(() => {});
      const tmp = `${cfg.tokensFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, cfg.tokensFile);
      await chmod(cfg.tokensFile, 0o600).catch(() => {});
      res.json({ ok: true, path: cfg.tokensFile });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/files', async (_req: Request, res: Response) => {
    try {
      const files = await listArchive();
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/upload', upload.single('file'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      const parsed = UploadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid month/year', details: parsed.error.flatten() });
        return;
      }
      const { month, year } = parsed.data;
      const filename = `${month}_${year}.csv`;
      const target = join(ARCHIVE_DIR, filename);
      await mkdir(ARCHIVE_DIR, { recursive: true });
      // Basic sanity: must look like a CSV (start with text, contain a comma)
      const head = req.file.buffer.subarray(0, Math.min(2048, req.file.buffer.length)).toString('utf8');
      if (!head.includes(',') || !/[\w\s]/.test(head)) {
        res.status(400).json({ error: 'File does not look like a CSV (no commas in first 2KB)' });
        return;
      }
      await writeFile(target, req.file.buffer);
      res.json({ ok: true, filename, savedAs: target });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/files/:name', async (req: Request, res: Response) => {
    try {
      const name = req.params.name ?? '';
      if (!/^[A-Za-z]+_\d{4}\.csv$/.test(name)) {
        res.status(400).json({ error: 'Invalid filename' });
        return;
      }
      await unlink(join(ARCHIVE_DIR, name));
      res.json({ ok: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/last-summary', async (_req: Request, res: Response) => {
    try {
      const reportDir = resolve('./reports');
      if (!existsSync(reportDir)) {
        res.json({ summary: null });
        return;
      }
      const names = await readdir(reportDir);
      const summaries = names.filter((n) => n.startsWith('summary-')).sort().reverse();
      if (summaries.length === 0) {
        res.json({ summary: null });
        return;
      }
      const path = join(reportDir, summaries[0] as string);
      const raw = await readFile(path, 'utf8');
      res.json({ summary: JSON.parse(raw), path });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List previous runs (newest first). The log file is authoritative — a run
  // always produces a log, but only completed runs produce a summary report.
  app.get('/api/runs', async (_req: Request, res: Response) => {
    try {
      const logDir = resolve('./logs');
      const reportDir = resolve('./reports');
      if (!existsSync(logDir)) {
        res.json({ runs: [] });
        return;
      }
      const logNames = (await readdir(logDir)).filter(
        (n) => n.startsWith('sync-') && n.endsWith('.jsonl'),
      );
      const reportNames = existsSync(reportDir) ? await readdir(reportDir) : [];
      const summaryNames = new Set(reportNames.filter((n) => n.startsWith('summary-')));
      const changelogNames = new Set(reportNames.filter((n) => n.startsWith('changelog-')));

      const runs = await Promise.all(
        logNames.map(async (name) => {
          const runId = name.replace(/^sync-/, '').replace(/\.jsonl$/, '');
          const logPath = join(logDir, name);
          const st = await stat(logPath);
          const summaryName = `summary-${runId}.json`;
          let summary: unknown = null;
          if (summaryNames.has(summaryName)) {
            try {
              summary = JSON.parse(
                await readFile(join(reportDir, summaryName), 'utf8'),
              );
            } catch {
              // ignore — fall back to log-only metadata
            }
          }
          return {
            runId,
            mtime: st.mtime.toISOString(),
            logSize: st.size,
            complete: summary !== null,
            hasChangelog: changelogNames.has(`changelog-${runId}.json`),
            summary,
          };
        }),
      );

      runs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Full log for one run — runId is the timestamp portion of the filename.
  app.get('/api/runs/:runId/log', async (req: Request, res: Response) => {
    const runId = req.params.runId ?? '';
    // Strict whitelist on the runId — it's user-supplied and goes into a path.
    if (!/^\d{8}-\d{6}$/.test(runId)) {
      res.status(400).json({ error: 'invalid runId' });
      return;
    }
    const logPath = join(resolve('./logs'), `sync-${runId}.jsonl`);
    if (!existsSync(logPath)) {
      res.status(404).json({ error: 'log not found' });
      return;
    }
    try {
      const content = await readFile(logPath, 'utf8');
      res.type('text/plain').send(content);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // SSE — sync stream
  app.post('/api/sync', async (req: Request, res: Response) => {
    let parsed: z.infer<typeof SyncRequestSchema>;
    try {
      parsed = SyncRequestSchema.parse(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const { newFile, oldFile, dryRun, allowCreateWithoutState } = parsed;

    if (newFile === oldFile) {
      res.status(400).json({ error: 'newFile and oldFile must differ' });
      return;
    }

    const newSrc = join(ARCHIVE_DIR, newFile);
    const oldSrc = join(ARCHIVE_DIR, oldFile);
    if (!existsSync(newSrc)) {
      res.status(400).json({ error: `${newFile} not in archive` });
      return;
    }
    if (!existsSync(oldSrc)) {
      res.status(400).json({ error: `${oldFile} not in archive` });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let runIdForCleanup: string | null = null;
    let abortCtrl: AbortController | null = null;

    // Watch for client disconnect (e.g., browser tab closed) → don't auto-abort,
    // since the user might just have closed the tab while the sync continues.
    // We only abort on an explicit /api/sync/cancel call.

    try {
      // Copy archived files → working copies new.csv and old.csv (where the python diff scripts expect them)
      send('log', { level: 30, msg: `copying ${newFile} → new.csv`, phase: 'web' });
      await copyFile(newSrc, join(ROOT_DIR, 'new.csv'));
      send('log', { level: 30, msg: `copying ${oldFile} → old.csv`, phase: 'web' });
      await copyFile(oldSrc, join(ROOT_DIR, 'old.csv'));

      const cfg = loadConfig();
      const runId = newRunId();
      runIdForCleanup = runId;
      abortCtrl = new AbortController();
      activeRuns.set(runId, abortCtrl);

      // When the run is aborted (by /api/sync/cancel), tell the UI immediately.
      abortCtrl.signal.addEventListener('abort', () => {
        send('cancelling', { runId });
      });

      const { logger, stream } = createWebLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
      stream.on('log', (obj: { level?: number; msg?: string; [key: string]: unknown }) => {
        send('log', obj);
      });

      send('start', { runId, newFile, oldFile, dryRun });

      const notifier = createNotifier(cfg, logger);

      try {
        await runSync({
          cfg,
          logger,
          runId,
          notifier,
          dryRun,
          allowCreateWithoutState,
          archiveNewCsvPath: newSrc,
          newFileName: newFile,
          oldFileName: oldFile,
          onProgress: (ev) => send('progress', ev),
          signal: abortCtrl.signal,
        });
        // After sync, fetch the latest summary
        const reportDir = resolve('./reports');
        const summaryPath = join(reportDir, `summary-${runId}.json`);
        let summary: unknown = null;
        try {
          summary = JSON.parse(await readFile(summaryPath, 'utf8'));
        } catch {
          // ignore
        }
        const wasCancelled = abortCtrl.signal.aborted;
        send('done', { ok: true, runId, summary, cancelled: wasCancelled });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const wasCancelled = abortCtrl.signal.aborted;
        send('done', { ok: !wasCancelled, runId, error: wasCancelled ? undefined : msg, cancelled: wasCancelled });
      }
    } catch (err) {
      send('done', { ok: false, error: (err as Error).message });
    } finally {
      if (runIdForCleanup) activeRuns.delete(runIdForCleanup);
      res.end();
    }
  });

  // ---------- Smoke test (one product end-to-end) ----------
  app.post('/api/smoke-one', async (req: Request, res: Response) => {
    let parsed: z.infer<typeof SmokeRequestSchema>;
    try {
      parsed = SmokeRequestSchema.parse(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const { newFile, code } = parsed;
    const newSrc = join(ARCHIVE_DIR, newFile);
    if (!existsSync(newSrc)) {
      res.status(400).json({ error: `${newFile} not in archive` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      send('log', { level: 30, msg: `smoke test: using ${newFile}${code ? ` (code=${code})` : ''}`, phase: 'web' });

      const cfg = loadConfig();
      const runId = newRunId();
      const { logger, stream } = createWebLogger({ runId, logDir: cfg.logDir, level: cfg.logLevel });
      stream.on('log', (obj: { level?: number; msg?: string; [key: string]: unknown }) => {
        send('log', obj);
      });

      send('start', { runId, newFile, code });

      const result = await runSmoke({
        cfg,
        logger,
        runId,
        code,
        csvPath: newSrc,
      });

      send('smoke-done', result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send('smoke-done', {
        ok: false,
        error: msg,
        probes: { collections: { ok: false }, medias: { ok: false } },
        product: null,
        roundTrip: [],
      });
    } finally {
      res.end();
    }
  });

  // ---------- Revert a previous run (SSE) ----------
  app.post('/api/runs/:runId/revert', async (req: Request, res: Response) => {
    const targetRunId = req.params.runId ?? '';
    if (!/^\d{8}-\d{6}$/.test(targetRunId)) {
      res.status(400).json({ error: 'invalid runId' });
      return;
    }
    const dryRun = req.body?.dryRun === true;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const cfg = loadConfig();
    const runId = newRunId();
    const abortCtrl = new AbortController();
    activeRuns.set(runId, abortCtrl);
    abortCtrl.signal.addEventListener('abort', () => send('cancelling', { runId }));

    const { logger, stream } = createWebLogger({
      runId,
      logDir: cfg.logDir,
      level: cfg.logLevel,
    });
    stream.on('log', (obj) => send('log', obj));

    send('start', { runId, targetRunId, dryRun, mode: 'revert' });

    try {
      const result = await runRevert({
        cfg,
        logger,
        runId,
        targetRunId,
        dryRun,
        onProgress: (ev) => send('progress', ev),
        signal: abortCtrl.signal,
      });
      send('done', { ok: true, runId, mode: 'revert', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send('done', { ok: false, runId, mode: 'revert', error: msg });
    } finally {
      activeRuns.delete(runId);
      res.end();
    }
  });

  // ---------- Wipe everything in state.json (SSE) ----------
  app.post('/api/wipe', async (req: Request, res: Response) => {
    const dryRun = req.body?.dryRun === true;
    const confirm = req.body?.confirm === 'WIPE EVERYTHING';
    if (!dryRun && !confirm) {
      res.status(400).json({
        error: 'wipe requires { confirm: "WIPE EVERYTHING" } (or dryRun: true)',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const cfg = loadConfig();
    const runId = newRunId();
    const abortCtrl = new AbortController();
    activeRuns.set(runId, abortCtrl);
    abortCtrl.signal.addEventListener('abort', () => send('cancelling', { runId }));

    const { logger, stream } = createWebLogger({
      runId,
      logDir: cfg.logDir,
      level: cfg.logLevel,
    });
    stream.on('log', (obj) => send('log', obj));

    send('start', { runId, dryRun, mode: 'wipe' });

    try {
      const result = await runWipe({
        cfg,
        logger,
        runId,
        dryRun,
        onProgress: (ev) => send('progress', ev),
        signal: abortCtrl.signal,
      });
      send('done', { ok: true, runId, mode: 'wipe', result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send('done', { ok: false, runId, mode: 'wipe', error: msg });
    } finally {
      activeRuns.delete(runId);
      res.end();
    }
  });

  // ---------- Cancel an active sync ----------
  app.post('/api/sync/cancel', (req: Request, res: Response) => {
    const parsed = CancelRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'runId required' });
      return;
    }
    const ctrl = activeRuns.get(parsed.data.runId);
    if (!ctrl) {
      res.status(404).json({ error: 'no active run with that id' });
      return;
    }
    if (ctrl.signal.aborted) {
      res.json({ ok: true, alreadyCancelling: true });
      return;
    }
    ctrl.abort();
    res.json({ ok: true });
  });

  // Health (kept inside the auth scope intentionally; if you need a public
  // healthcheck, register it before basicAuthMiddleware)
  app.get('/healthz', (_req: Request, res: Response) => res.send('ok'));

  // Default: serve index.html for any unmatched GET (SPA-friendly, even though we have one page)
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(join(STATIC_DIR, 'index.html'));
  });

  return app;
}

// Railway sets PORT; locally we fall back to WEB_PORT or 3001.
const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3001);
// Bind to 0.0.0.0 on hosted platforms (Railway routes traffic from outside the
// container); locally we still want 127.0.0.1 to keep the UI off the LAN.
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';

/**
 * Bootstrap tokens.json from env vars on first boot.
 * Railway's filesystem is ephemeral — every redeploy wipes tokens.json. If the
 * user has set GHL_ACCESS_TOKEN / GHL_REFRESH_TOKEN / GHL_TOKEN_EXPIRES_AT in
 * their env, we write the file from those values so the app self-bootstraps.
 *
 * Subsequent refreshes still update tokens.json in place — so if a Railway
 * Volume is mounted, refreshed tokens persist across restarts. Without a
 * volume, every redeploy re-bootstraps from the env vars (still works, but
 * the refresh-token rotation chain restarts every deploy).
 */
async function bootstrapTokensFromEnv(): Promise<void> {
  const cfg = loadConfig();
  if (existsSync(cfg.tokensFile)) return;
  const accessToken = process.env.GHL_ACCESS_TOKEN;
  const refreshToken = process.env.GHL_REFRESH_TOKEN;
  const expiresAtRaw = process.env.GHL_TOKEN_EXPIRES_AT;
  if (!accessToken || !refreshToken || !expiresAtRaw) return;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    console.warn('GHL_TOKEN_EXPIRES_AT is not a number — skipping token bootstrap');
    return;
  }
  await mkdir(dirname(cfg.tokensFile), { recursive: true }).catch(() => {});
  await writeFile(
    cfg.tokensFile,
    `${JSON.stringify({ accessToken, refreshToken, expiresAt, locationId: cfg.ghlLocationId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(cfg.tokensFile, 0o600).catch(() => {});
  console.log(`✓ bootstrapped ${cfg.tokensFile} from env vars`);
}

async function main(): Promise<void> {
  await bootstrapTokensFromEnv();
  const app = buildApp();
  const authOn = !!(process.env.WEB_AUTH_USER && process.env.WEB_AUTH_PASS);
  app.listen(PORT, HOST, () => {
    console.log(`\n✓ xyz-sync UI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (authOn) {
      console.log(`  auth: HTTP Basic — user "${process.env.WEB_AUTH_USER}"\n`);
    } else {
      console.log('  auth: DISABLED (set WEB_AUTH_USER + WEB_AUTH_PASS to enable)\n');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
