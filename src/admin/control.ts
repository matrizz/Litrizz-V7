import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ConnectionState, HealthInfo } from '../core/connection.js';
import { getRecentLogLines } from '../core/logger.js';

export type ControlAction = 'restart' | 'update' | 'rollback';

export interface BotStatus {
  readonly state: ConnectionState;
  readonly uptimeSec: number;
  readonly commit: string;
  readonly node: string;
  readonly rssMb: number;
  readonly queue: { active: number; waiting: number };
  readonly pending: ReadonlyArray<{ action: ControlAction; ageSec: number }>;
}

const pendingSchema = z.object({
  id: z.string(),
  action: z.enum(['restart', 'update', 'rollback']),
  replyJid: z.string(),
  requestedAt: z.string(),
});
const resultSchema = z.object({
  id: z.string(),
  action: z.string(),
  ok: z.boolean(),
  message: z.string(),
  finishedAt: z.string(),
});

export type PendingRequest = z.infer<typeof pendingSchema>;
export type ControlResult = z.infer<typeof resultSchema>;
export interface FinishedAction {
  readonly request: PendingRequest;
  readonly result: ControlResult;
}

export interface ControlService {
  getStatus(): Promise<BotStatus>;
  getLogs(lines: number): string[];
  requestAction(action: ControlAction, replyJid: string): Promise<PendingRequest>;
  collectFinished(): Promise<FinishedAction[]>;
  acknowledge(id: string): Promise<void>;
}

interface Deps {
  readonly controlDir: string;
  readonly commit: string;
  readonly startedAt: number;
  readonly getHealth: () => HealthInfo;
  readonly getQueueStats: () => { active: number; waiting: number };
}

const PENDING_TTL_MS = 24 * 3600_000;

export class FileControlService implements ControlService {
  constructor(private readonly deps: Deps) {}

  private dir(name: 'requests' | 'pending' | 'results' | 'tmp'): string {
    return path.join(this.deps.controlDir, name);
  }

  async init(): Promise<void> {
    for (const name of ['requests', 'pending', 'results', 'tmp'] as const) {
      await fs.mkdir(this.dir(name), { recursive: true });
    }
  }

  async getStatus(): Promise<BotStatus> {
    const pending = await this.readPending();
    return {
      state: this.deps.getHealth().state,
      uptimeSec: Math.round((Date.now() - this.deps.startedAt) / 1000),
      commit: this.deps.commit,
      node: process.version,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      queue: this.deps.getQueueStats(),
      pending: pending.map((p) => ({
        action: p.action,
        ageSec: Math.round((Date.now() - Date.parse(p.requestedAt)) / 1000),
      })),
    };
  }

  getLogs(lines: number): string[] {
    return getRecentLogLines(lines);
  }

  async requestAction(action: ControlAction, replyJid: string): Promise<PendingRequest> {
    await this.init();
    const request: PendingRequest = {
      id: randomBytes(6).toString('hex'),
      action,
      replyJid,
      requestedAt: new Date().toISOString(),
    };
    await this.writeAtomic(path.join(this.dir('pending'), `${request.id}.json`), JSON.stringify(request));

    if (action === 'restart') {
      const result: ControlResult = {
        id: request.id,
        action,
        ok: true,
        message: 'reiniciado',
        finishedAt: new Date().toISOString(),
      };
      await this.writeAtomic(path.join(this.dir('results'), `${request.id}.json`), JSON.stringify(result));
    } else {
      await this.writeAtomic(path.join(this.dir('requests'), `${action}-${request.id}.req`), '');
    }
    return request;
  }

  async collectFinished(): Promise<FinishedAction[]> {
    await this.init();
    const out: FinishedAction[] = [];
    for (const file of await fs.readdir(this.dir('results')).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue;
      const resultPath = path.join(this.dir('results'), file);
      const result = await this.readJson(resultPath, resultSchema);
      const request = result ? await this.readJson(path.join(this.dir('pending'), file), pendingSchema) : null;
      if (result && request) out.push({ request, result });
      else await fs.rm(resultPath, { force: true });
    }
    return out;
  }

  async acknowledge(id: string): Promise<void> {
    if (!/^[a-z0-9]+$/i.test(id)) return;
    await fs.rm(path.join(this.dir('results'), `${id}.json`), { force: true });
    await fs.rm(path.join(this.dir('pending'), `${id}.json`), { force: true });
  }

  private async readPending(): Promise<PendingRequest[]> {
    const out: PendingRequest[] = [];
    for (const file of await fs.readdir(this.dir('pending')).catch(() => [] as string[])) {
      const full = path.join(this.dir('pending'), file);
      const p = await this.readJson(full, pendingSchema);
      if (!p) continue;
      if (Date.now() - Date.parse(p.requestedAt) > PENDING_TTL_MS) await fs.rm(full, { force: true });
      else out.push(p);
    }
    return out;
  }

  private async readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      return schema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch {
      return null;
    }
  }

  private async writeAtomic(target: string, content: string): Promise<void> {
    const tmp = path.join(this.dir('tmp'), `${path.basename(target)}.${randomBytes(4).toString('hex')}`);
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, target);
  }
}
