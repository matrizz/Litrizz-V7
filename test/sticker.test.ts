import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import webpmux from 'node-webpmux';
import { describe, expect, it } from 'vitest';
import { convertToSticker } from '../src/features/sticker/converter.js';

const pack = { name: 'Pack de Teste', author: 'Autor de Teste' };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function readExif(webp: Buffer): Promise<string> {
  const img = new webpmux.Image();
  await img.load(webp);
  return img.exif?.toString('utf8') ?? '';
}

describe('convertToSticker', () => {
  it('foto retangular → webp 512x512 com metadados, < 100 KB', async () => {
    const photo = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: { r: 200, g: 40, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    const { webp, animated } = await convertToSticker(photo, 'image', {
      fit: 'contain',
      maxVideoSeconds: 10,
      maxAnimatedBytes: 800 * 1024,
      pack,
    });
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([512, 512]);
    expect(webp.length).toBeLessThan(100 * 1024);
    expect(animated).toBe(false);
    const exif = await readExif(webp);
    expect(exif).toContain('Pack de Teste');
    expect(exif).toContain('Autor de Teste');
  });

  it('lixo no lugar de imagem → erro amigável', async () => {
    await expect(
      convertToSticker(Buffer.from('isso não é uma imagem'), 'image', {
        fit: 'contain', maxVideoSeconds: 10, maxAnimatedBytes: 800 * 1024, pack,
      }),
    ).rejects.toThrow(/ler essa imagem/);
  });

  it.skipIf(!hasFfmpeg)('vídeo → webp animado 512x512 dentro do limite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
    const file = path.join(dir, 'in.mp4');
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4',
      '-pix_fmt', 'yuv420p', file,
    ]);
    const { webp, animated } = await convertToSticker(fs.readFileSync(file), 'video', {
      fit: 'contain',
      maxVideoSeconds: 10,
      maxAnimatedBytes: 800 * 1024,
      pack,
    });
    const meta = await sharp(webp, { animated: true }).metadata();
    expect(animated).toBe(true);
    expect(meta.width).toBe(512);
    expect(meta.pageHeight ?? meta.height).toBe(512);
    expect(meta.pages ?? 1).toBeGreaterThan(1);
    expect(webp.length).toBeLessThanOrEqual(800 * 1024);
    expect(await readExif(webp)).toContain('Pack de Teste');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
