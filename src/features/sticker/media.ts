import {
  downloadMediaMessage,
  normalizeMessageContent,
  type proto,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import { toNumber } from '../../core/utils.js';
import type { MediaKind } from './converter.js';

export interface MediaRef {
  readonly kind: MediaKind;

  readonly message: WAMessage;
  readonly sizeBytes: number;
}

function pick(content: proto.IMessage): { kind: MediaKind; sizeBytes: number } | null {
  if (content.imageMessage) return { kind: 'image', sizeBytes: toNumber(content.imageMessage.fileLength) };
  if (content.videoMessage) return { kind: 'video', sizeBytes: toNumber(content.videoMessage.fileLength) };
  return null;
}


export function findMedia(msg: WAMessage): MediaRef | null {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;

  const direct = pick(content);
  if (direct) return { ...direct, message: msg };

  const ctx =
    content.extendedTextMessage?.contextInfo ?? content.imageMessage?.contextInfo ?? content.videoMessage?.contextInfo;
  const quoted = normalizeMessageContent(ctx?.quotedMessage);
  if (!ctx || !quoted) return null;

  const found = pick(quoted);
  if (!found) return null;
  const message: WAMessage = {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ctx.stanzaId ?? undefined,
      participant: ctx.participant ?? undefined,
      fromMe: false,
    },
    message: quoted,
  };
  return { ...found, message };
}

export function downloadMedia(sock: WASocket, ref: MediaRef, logger: Logger): Promise<Buffer> {
  return downloadMediaMessage(ref.message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
}
