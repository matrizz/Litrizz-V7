import { describe, expect, it } from 'vitest';
import { JobQueue, JobTimeoutError, QueueFullError } from '../src/core/queue.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('JobQueue', () => {
  it('respeita a concorrência máxima', async () => {
    const q = new JobQueue(2, 10);
    let running = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      running++;
      peak = Math.max(peak, running);
      await sleep(30);
      running--;
    };
    await Promise.all(Array.from({ length: 6 }, () => q.run(job, 1000)));
    expect(peak).toBe(2);
    expect(q.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('rejeita quando a fila enche', async () => {
    const q = new JobQueue(1, 1);
    const slow = (): Promise<void> => sleep(50);
    const a = q.run(slow, 1000);
    const b = q.run(slow, 1000);
    await expect(q.run(slow, 1000)).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all([a, b]);
  });

  it('aborta o job no timeout e libera a vaga', async () => {
    const q = new JobQueue(1, 1);
    const hang = (signal: AbortSignal): Promise<void> =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abortado'))));
    await expect(q.run(hang, 20)).rejects.toBeInstanceOf(JobTimeoutError);
    await expect(q.run(() => Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});
