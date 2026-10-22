import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

type CredsState = 'missing' | 'corrupt' | 'incomplete' | 'complete';

export class AuthStore {
  private lastBackupAt = 0;
  private backingUp = false;

  constructor(
    private readonly authDir: string,
    private readonly backupDir: string,
    private readonly logger: Logger,
    private readonly keep = 5,
    private readonly minIntervalMs = 30 * 60_000,
  ) { }

  private credsPath(dir: string): string {
    return path.join(dir, 'creds.json');
  }

  private async inspect(dir: string): Promise<CredsState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.credsPath(dir), 'utf8');
    } catch {
      return 'missing';
    }
    try {
      const creds = JSON.parse(raw) as { account?: unknown } | null;
      if (creds === null || typeof creds !== 'object') return 'corrupt';
      return creds.account ? 'complete' : 'incomplete';
    } catch {
      return 'corrupt';
    }
  }

  private async listBackups(): Promise<string[]> {
    const entries = await fs.readdir(this.backupDir).catch(() => [] as string[]);
    return entries
      .filter((e) => e.startsWith('auth-') && !e.endsWith('.tmp'))
      .sort()
      .reverse()
      .map((e) => path.join(this.backupDir, e));
  }

  async ensureValid(): Promise<'ok' | 'restored' | 'empty'> {
    await fs.mkdir(this.authDir, { recursive: true });
    const state = await this.inspect(this.authDir);

    if (state === 'missing') return 'empty';
    if (state === 'complete') return 'ok';

    if (state === 'incomplete') {
      this.logger.warn('pareamento anterior não foi concluído — descartando credenciais provisórias');
      await fs.rm(this.authDir, { recursive: true, force: true });
      await fs.mkdir(this.authDir, { recursive: true });
      return 'empty';
    }

    this.logger.error('creds.json corrompido — tentando restaurar do backup');
    for (const candidate of await this.listBackups()) {
      if ((await this.inspect(candidate)) !== 'complete') continue;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.rename(this.authDir, `${this.authDir}.corrupt-${stamp}`);
      await fs.cp(candidate, this.authDir, { recursive: true });
      this.logger.warn({ from: path.basename(candidate) }, 'sessão restaurada do backup');
      return 'restored';
    }
    this.logger.error('nenhum backup válido encontrado; será necessário parear de novo (./ctl pair)');
    return 'empty';
  }

  async maybeBackup(force = false): Promise<void> {
    if (this.backingUp) return;
    if (!force && Date.now() - this.lastBackupAt < this.minIntervalMs) return;
    this.backingUp = true;
    try {
      if ((await this.inspect(this.authDir)) !== 'complete') return;
      await fs.mkdir(this.backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tmp = path.join(this.backupDir, `auth-${stamp}.tmp`);
      const final = path.join(this.backupDir, `auth-${stamp}`);
      await fs.cp(this.authDir, tmp, { recursive: true });
      await fs.rename(tmp, final);
      this.lastBackupAt = Date.now();
      for (const old of (await this.listBackups()).slice(this.keep)) {
        await fs.rm(old, { recursive: true, force: true });
      }
      this.logger.debug({ backup: path.basename(final) }, 'backup da sessão criado');
    } catch (err) {
      this.logger.warn({ err }, 'falha ao criar backup da sessão');
    } finally {
      this.backingUp = false;
    }
  }
}