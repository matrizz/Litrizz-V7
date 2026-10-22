import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore } from '../src/core/auth-store.js';

let root: string;
const logger = pino({ level: 'silent' });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{ store: AuthStore; auth: string; backups: string }> {
  const auth = path.join(root, 'auth');
  const backups = path.join(root, 'backups');
  await fs.mkdir(auth, { recursive: true });
  return { store: new AuthStore(auth, backups, logger, 2, 0), auth, backups };
}

describe('AuthStore', () => {
  it('sessão vazia → "empty"', async () => {
    const { store } = await setup();
    expect(await store.ensureValid()).toBe('empty');
  });

  it('restaura do backup quando creds.json corrompe (queda de luz)', async () => {
    const { store, auth } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), JSON.stringify({ me: 'ok', account: { details: 'x' } }));
    await store.maybeBackup(true);

    await fs.writeFile(path.join(auth, 'creds.json'), '{"me": "meio-escr');
    expect(await store.ensureValid()).toBe('restored');
    expect(JSON.parse(await fs.readFile(path.join(auth, 'creds.json'), 'utf8'))).toEqual({ me: 'ok', account: { details: 'x' } });
  });

  it('descarta pareamento incompleto (me provisório, sem account) em vez de fazer login com ele', async () => {
    const { store, auth } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), JSON.stringify({ me: { id: '5513@s.whatsapp.net' }, registered: false }));
    await fs.writeFile(path.join(auth, 'outro-arquivo.json'), '{}');
    expect(await store.ensureValid()).toBe('empty');
    expect(await fs.readdir(auth)).toEqual([]);
  });

  it('mantém sessão completa (com account)', async () => {
    const { store, auth } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), JSON.stringify({ me: { id: 'x' }, account: { details: 'y' } }));
    expect(await store.ensureValid()).toBe('ok');
    expect(await fs.readdir(auth)).toEqual(['creds.json']);
  });

  it('não faz backup de sessão incompleta', async () => {
    const { store, auth, backups } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), JSON.stringify({ me: { id: 'x' } }));
    await store.maybeBackup(true);
    expect(await fs.readdir(backups).catch(() => [])).toEqual([]);
  });

  it('nunca faz backup de sessão corrompida', async () => {
    const { store, auth, backups } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), '{quebrado');
    await store.maybeBackup(true);
    expect(await fs.readdir(backups).catch(() => [])).toEqual([]);
  });

  it('mantém só os N backups mais recentes', async () => {
    const { store, auth, backups } = await setup();
    await fs.writeFile(path.join(auth, 'creds.json'), JSON.stringify({ account: {} }));
    for (let i = 0; i < 4; i++) {
      await store.maybeBackup(true);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await fs.readdir(backups)).length).toBe(2);
  });
});