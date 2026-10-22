import type { Command } from '../../commands/types.js';
import { UserError } from '../../core/errors.js';
import { convertToSticker, type FitMode } from './converter.js';
import { downloadMedia, findMedia } from './media.js';

export const stickerCommand: Command = {
  name: 'sticker',
  aliases: ['s', 'figurinha', 'fig'],
  description: 'Transforma foto ou vídeo em figurinha',
  usage: '.sticker [crop]  (foto/vídeo com essa legenda, ou respondendo a uma foto/vídeo)',
  permission: 'anyone',

  async run(ctx) {
    const { config, queue, logger } = ctx.services;

    const media = findMedia(ctx.msg);
    if (!media) {
      throw new UserError('Envie uma foto/vídeo com a legenda .sticker, ou responda a uma foto/vídeo com .sticker');
    }
    if (media.sizeBytes > config.maxInputBytes) {
      throw new UserError(`Arquivo grande demais (máx. ${Math.round(config.maxInputBytes / 1024 / 1024)} MB).`);
    }

    const fit: FitMode = ctx.args.includes('crop') ? 'cover' : 'contain';
    await ctx.react('⏳');
    try {
      const started = Date.now();
      const result = await queue.run(async (signal) => {
        const input = await downloadMedia(ctx.sock, media, logger);
        return convertToSticker(input, media.kind, {
          fit,
          maxVideoSeconds: config.maxVideoSeconds,
          maxAnimatedBytes: config.maxAnimatedBytes,
          pack: { name: config.packName, author: config.packAuthor },
          signal,
        });
      }, config.jobTimeoutMs);

      const deleteCommand = config.deleteCommandMessage && ctx.fromMe;
      await ctx.sock.sendMessage(
        ctx.chatJid,
        { sticker: result.webp, isAnimated: result.animated },
        deleteCommand ? undefined : { quoted: ctx.msg },
      );
      if (deleteCommand) await ctx.sock.sendMessage(ctx.chatJid, { delete: ctx.msg.key });

      logger.info(
        { kind: media.kind, bytes: result.webp.length, ms: Date.now() - started },
        'figurinha enviada',
      );
    } finally {
      await ctx.react('');
    }
  },
};
