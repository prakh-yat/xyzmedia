import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Level, type Logger } from 'pino';

/**
 * A pino destination that emits each parsed log object via EventEmitter.
 * Used by the web server to stream sync logs to a connected SSE client.
 */
export class LogStream extends EventEmitter {
  write(chunk: string): boolean {
    const trimmed = chunk.trim();
    if (!trimmed) return true;
    try {
      const obj = JSON.parse(trimmed);
      this.emit('log', obj);
    } catch {
      // Non-JSON line (rare) — emit as raw
      this.emit('log', { msg: trimmed, level: 30 });
    }
    return true;
  }
}

export interface WebLoggerOpts {
  runId: string;
  logDir: string;
  level?: Level;
}

export interface WebLoggerHandle {
  logger: Logger;
  stream: LogStream;
}

export function createWebLogger(opts: WebLoggerOpts): WebLoggerHandle {
  mkdirSync(opts.logDir, { recursive: true });
  const filePath = join(opts.logDir, `sync-${opts.runId}.jsonl`);
  const fileStream = pino.destination({ dest: filePath, sync: false, mkdir: true });
  const eventStream = new LogStream();

  const consoleLevel: Level = opts.level ?? 'info';

  const logger = pino(
    {
      level: 'trace',
      base: { run_id: opts.runId },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: fileStream, level: 'trace' as Level },
      { stream: eventStream, level: consoleLevel },
    ]),
  );

  return { logger, stream: eventStream };
}
