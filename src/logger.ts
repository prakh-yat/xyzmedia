import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Level, type Logger } from 'pino';

export interface LoggerOpts {
  runId: string;
  logDir: string;
  level?: Level;
}

export function createLogger(opts: LoggerOpts): Logger {
  mkdirSync(opts.logDir, { recursive: true });
  const filePath = join(opts.logDir, `sync-${opts.runId}.jsonl`);

  const consoleLevel: Level = opts.level ?? 'info';

  const fileStream = pino.destination({ dest: filePath, sync: false, mkdir: true });
  const streams: pino.StreamEntry[] = [{ stream: fileStream, level: 'trace' as Level }];

  if (process.stdout.isTTY) {
    const pretty = pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,run_id' },
    });
    streams.push({ stream: pretty, level: consoleLevel });
  } else {
    streams.push({ stream: process.stdout, level: consoleLevel });
  }

  return pino(
    {
      level: 'trace',
      base: { run_id: opts.runId },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
