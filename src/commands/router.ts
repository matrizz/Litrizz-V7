import { jidDecode, jidNormalizedUser, normalizeMessageContent, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import { UserError } from '../core/errors.js';
import { toNumber } from '../core/utils.js';
import type { CommandRegistry } from './registry.js';
import type { Command, CommandContext, Permission, Services } from './types.js';

export interface ParsedCommand {
  readonly name: string;
  readonly args: string[];
}

export function parseCommand(text: string, prefix: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const [head, ...rest] = trimmed.slice(prefix.length).split(/\s+/);
  if (!head || !/^[a-z0-9_-]+$/i.test(head)) return null;
  return { name: head.toLowerCase(), args: rest.filter((a) => a.length > 0) };
}

export function extractText(msg: WAMessage): string {
  const c = normalizeMessageContent(msg.message);
  return (
    c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? ''
  );
}

const MAX_MESSAGE_AGE_S = 120;
const MAX_SEEN = 1000;

export class CommandRouter {
  private readonly seen = new Set<string>();
  private readonly lastUse = new Map<string, number>();

  constructor(
    private readonly registry: CommandRegistry,
    private readonly services: Services,
  ) {}

  handle(sock: WASocket, msg: WAMessage): void {
    this.process(sock, msg).catch((err: unknown) => this.services.logger.error({ err }, 'erro no roteador'));
  }

  private async process(sock: WASocket, msg: WAMessage): Promise<void> {
    const chatJid = msg.key.remoteJid;
    if (!chatJid || !msg.message || !msg.key.id) return;
    if (chatJid === 'status@broadcast' || chatJid.endsWith('@newsletter')) return;

    const ageS = Date.now() / 1000 - toNumber(msg.messageTimestamp);
    if (ageS > MAX_MESSAGE_AGE_S) return;
    const dedupeKey = `${chatJid}:${msg.key.id}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);

    const parsed = parseCommand(extractText(msg), this.services.config.prefix);
    if (!parsed) return;
    const command = this.registry.resolve(parsed.name);
    if (!command) return;

    const fromMe = msg.key.fromMe === true;
    if (!this.isAllowed(command.permission, sock, msg, chatJid, fromMe)) return;
    if (!fromMe && this.onCooldown(chatJid)) return;

    const ctx = this.buildContext(sock, msg, chatJid, parsed.args, fromMe);
    this.services.logger.info({ command: command.name, chat: chatJid, fromMe }, 'comando recebido');
    await this.run(command, ctx);
  }

  private async run(command: Command, ctx: CommandContext): Promise<void> {
    try {
      await command.run(ctx);
    } catch (err) {
      if (err instanceof UserError) {
        await ctx.reply(`⚠️ ${err.message}`);
        return;
      }
      this.services.logger.error({ err, command: command.name }, 'comando falhou');
      await ctx.reply('❌ Algo deu errado. Tenta de novo; se persistir, veja os logs com .logs');
    }
  }

  private buildContext(
    sock: WASocket,
    msg: WAMessage,
    chatJid: string,
    args: readonly string[],
    fromMe: boolean,
  ): CommandContext {
    const log = this.services.logger;
    return {
      sock,
      msg,
      chatJid,
      args,
      fromMe,
      services: this.services,
      reply: async (text) => {
        try {
          await sock.sendMessage(chatJid, { text }, { quoted: msg });
        } catch (err) {
          log.warn({ err }, 'falha ao responder');
        }
      },
      react: async (emoji) => {
        try {
          await sock.sendMessage(chatJid, { react: { text: emoji, key: msg.key } });
        } catch {
        }
      },
    };
  }

  private isAllowed(permission: Permission, sock: WASocket, msg: WAMessage, chatJid: string, fromMe: boolean): boolean {
    switch (permission) {
      case 'owner':
        return fromMe;
      case 'owner-self-chat':
        return fromMe && this.isSelfChat(sock, msg, chatJid);
      case 'anyone':
        return fromMe || this.isInAllowList(msg);
    }
  }

  private isInAllowList(msg: WAMessage): boolean {
    const allowed = this.services.config.allowedNumbers;
    if (allowed.length === 0) return false;
    const { key } = msg;
    const candidates = [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt]
      .filter((j): j is string => typeof j === 'string')
      .map((j) => jidDecode(j)?.user)
      .filter((u): u is string => u !== undefined);
    return candidates.some((u) => allowed.includes(u));
  }

  private isSelfChat(sock: WASocket, msg: WAMessage, chatJid: string): boolean {
    const own = [sock.user?.id, sock.user?.lid]
      .filter((j): j is string => typeof j === 'string')
      .map((j) => jidNormalizedUser(j));
    const targets = [chatJid, msg.key.remoteJidAlt].filter((j): j is string => typeof j === 'string');
    return targets.some((t) => own.includes(jidNormalizedUser(t)));
  }

  private onCooldown(chatJid: string): boolean {
    const cooldown = this.services.config.userCooldownMs;
    if (cooldown === 0) return false;
    const now = Date.now();
    const last = this.lastUse.get(chatJid) ?? 0;
    if (now - last < cooldown) return true;
    this.lastUse.set(chatJid, now);
    if (this.lastUse.size > 500) this.lastUse.clear();
    return false;
  }
}
