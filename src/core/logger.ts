import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

class RingBufferStream extends Writable {
  private readonly lines: string[] = [];

  constructor(private readonly capacity: number) {
    super();
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    this.lines.push(chunk.toString().trimEnd());
    if (this.lines.length > this.capacity) this.lines.shift();
    cb();
  }

  snapshot(): readonly string[] {
    return this.lines;
  }
}

const ring = new RingBufferStream(300);

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};

interface LogLine {
  level?: number;
  time?: string;
  msg?: string;
  err?: { message?: string };
}

export function createLogger(level: string): Logger {
  return pino(
    { level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream([{ stream: process.stdout }, { stream: ring }]),
  );
}

export function getRecentLogLines(count: number): string[] {
  return ring
    .snapshot()
    .slice(-count)
    .map((raw) => {
      try {
        const l = JSON.parse(raw) as LogLine;
        const time = l.time ? l.time.slice(11, 19) : '--:--:--';
        const lvl = LEVEL_NAMES[l.level ?? 30] ?? 'INFO';
        const err = l.err?.message ? ` (${l.err.message})` : '';
        return `${time} ${lvl} ${l.msg ?? ''}${err}`;
      } catch {
        return raw;
      }
    });
}
