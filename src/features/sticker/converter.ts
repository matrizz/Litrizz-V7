import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { UserError } from '../../core/errors.js';
import { addStickerMetadata, type PackMetadata } from './exif.js';

sharp.cache(false);
sharp.concurrency(1);

export type FitMode = 'contain' | 'cover';
export type MediaKind = 'image' | 'video';

export interface ConvertOptions {
  readonly fit: FitMode;
  readonly maxVideoSeconds: number;
  readonly maxAnimatedBytes: number;
  readonly pack: PackMetadata;
  readonly signal?: AbortSignal;
}

export interface StickerResult {
  readonly webp: Buffer;
  readonly animated: boolean;
}

const SIZE = 512;
const MAX_STATIC_BYTES = 95 * 1024;

async function imageToWebp(input: Buffer, fit: FitMode): Promise<Buffer> {
  try {
    const base = sharp(input, { failOn: 'none' })
      .rotate()
      .resize(SIZE, SIZE, { fit, position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha();
    for (const quality of [80, 65, 50, 35, 20]) {
      const out = await base.clone().webp({ quality, effort: 4 }).toBuffer();
      if (out.length <= MAX_STATIC_BYTES) return out;
    }
  } catch {
    throw new UserError('Não consegui ler essa imagem. Tenta mandar outra.');
  }
  throw new UserError('Essa imagem ficou pesada demais para virar figurinha.');
}

function runFfmpeg(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const onAbort = (): void => {
      proc.kill('SIGKILL');
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? 'ffmpeg abortado' : `ffmpeg saiu com código ${String(code)}: ${stderr}`));
    });
  });
}

const LADDER: ReadonlyArray<{ fps: number; quality: number }> = [
  { fps: 15, quality: 60 },
  { fps: 12, quality: 45 },
  { fps: 10, quality: 32 },
  { fps: 8, quality: 22 },
];

function videoFilter(fps: number, fit: FitMode): string {
  const scale =
    fit === 'cover'
      ? `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SIZE}:${SIZE},format=rgba`
      : `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,` +
        `pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  return `fps=${fps},${scale}`;
}

async function videoToWebp(input: Buffer, o: ConvertOptions): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sticker-'));
  try {
    const inFile = path.join(dir, 'input.bin');
    const outFile = path.join(dir, 'output.webp');
    await fs.writeFile(inFile, input);

    for (const [index, step] of LADDER.entries()) {
      const isLast = index === LADDER.length - 1;
      const seconds = isLast ? Math.max(2, Math.floor(o.maxVideoSeconds / 2)) : o.maxVideoSeconds;
      await runFfmpeg(
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-t', String(seconds),
          '-i', inFile,
          '-vf', videoFilter(step.fps, o.fit),
          '-an',
          '-threads', '2',
          '-c:v', 'libwebp',
          '-lossless', '0',
          '-quality', String(step.quality),
          '-compression_level', '4',
          '-loop', '0',
          '-f', 'webp',
          outFile,
        ],
        o.signal,
      );
      const out = await fs.readFile(outFile);
      if (out.length <= o.maxAnimatedBytes) return out;
    }
    throw new UserError('Esse vídeo ficou pesado demais para virar figurinha. Tenta um mais curto ou simples.');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function convertToSticker(input: Buffer, kind: MediaKind, o: ConvertOptions): Promise<StickerResult> {
  const raw = kind === 'image' ? await imageToWebp(input, o.fit) : await videoToWebp(input, o);
  return { webp: await addStickerMetadata(raw, o.pack), animated: kind === 'video' };
}
