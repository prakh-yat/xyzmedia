import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const exec = promisify(execFile);

export interface RunDiffsOpts {
  dataDir: string;
  pythonBin: string;
  /** Directory containing diff_csv.py and diff_categories.py. */
  scriptsDir: string;
  logger: Logger;
}

export interface DiffResult {
  changesCsv: string;
  categoryChangesCsv: string;
}

export async function runDiffs(opts: RunDiffsOpts): Promise<DiffResult> {
  const dataDir = resolve(opts.dataDir);
  for (const script of ['diff_csv.py', 'diff_categories.py']) {
    const scriptPath = resolve(opts.scriptsDir, script);
    opts.logger.info({ script: scriptPath, cwd: dataDir }, 'running diff script');
    try {
      const { stdout, stderr } = await exec(opts.pythonBin, [scriptPath], {
        cwd: dataDir,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr.trim()) opts.logger.warn({ script, stderr: stderr.trim() }, 'python stderr (non-fatal)');
      opts.logger.info({ script, stdout: stdout.trim() }, 'diff script ok');
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (e.code === 'ENOENT') {
        throw new Error(
          `Python not found at "${opts.pythonBin}". Install python3 or set PYTHON_BIN in .env ` +
            '(e.g. /opt/homebrew/bin/python3 on macOS, or "py" on Windows).',
        );
      }
      const detail = e.stderr ?? e.message ?? String(err);
      throw new Error(`Diff script ${script} failed: ${detail}`);
    }
  }
  return {
    changesCsv: join(dataDir, 'changes.csv'),
    categoryChangesCsv: join(dataDir, 'category_changes.csv'),
  };
}
