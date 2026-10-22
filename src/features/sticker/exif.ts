import { createHash } from 'node:crypto';
import webpmux from 'node-webpmux';

export interface PackMetadata {
  readonly name: string;
  readonly author: string;
}


export function buildExif(pack: PackMetadata): Buffer {
  const body = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': createHash('sha1').update(`${pack.name}\0${pack.author}`).digest('hex'),
      'sticker-pack-name': pack.name,
      'sticker-pack-publisher': pack.author,
      emojis: [],
    }),
    'utf8',
  );

  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([header, body]);
  exif.writeUInt32LE(body.length, 14);
  return exif;
}

export async function addStickerMetadata(webp: Buffer, pack: PackMetadata): Promise<Buffer> {
  const image = new webpmux.Image();
  await image.load(webp);
  image.exif = buildExif(pack);
  return image.save(null);
}
