import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { ControlService } from '../admin/control.js';
import type { AppConfig } from '../core/config.js';
import type { JobQueue } from '../core/queue.js';

export type Permission = 'anyone' | 'owner' | 'owner-self-chat';

export interface Services {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly queue: JobQueue;
  readonly control: ControlService;
  listCommands(): readonly Command[];
  shutdown(reason: string, exitCode: number): Promise<void>;
}

export interface CommandContext {
  readonly sock: WASocket;
  readonly msg: WAMessage;
  readonly chatJid: string;
  readonly args: readonly string[];
  readonly fromMe: boolean;
  readonly services: Services;
  reply(text: string): Promise<void>;
  react(emoji: string): Promise<void>;
}

export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly permission: Permission;
  run(ctx: CommandContext): Promise<void>;
}
