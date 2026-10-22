import { UserError } from './errors.js';

export class QueueFullError extends UserError {
  constructor() {
    super('Estou com muitas figurinhas na fila agora. Tenta de novo em instantes 🙏');
  }
}

export class JobTimeoutError extends UserError {
  constructor() {
    super('Demorou demais para converter e cancelei. Tenta um vídeo menor/mais curto.');
  }
}

export class JobQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting: number,
  ) {}

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(job: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw new QueueFullError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new JobTimeoutError()), timeoutMs);
    try {
      return await job(controller.signal);
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof JobTimeoutError) {
        throw controller.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.active > 0 || this.waiting.length > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
