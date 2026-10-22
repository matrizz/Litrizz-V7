import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import {
  helpCommand,
  logsCommand,
  pingCommand,
  restartCommand,
  rollbackCommand,
  statusCommand,
  updateCommand,
} from './admin/commands.js';
import { FileControlService } from './admin/control.js';
import { CommandRegistry } from './commands/registry.js';
import { CommandRouter } from './commands/router.js';
import type { Services } from './commands/types.js';
import { AuthStore } from './core/auth-store.js';
import { loadConfig, type AppConfig } from './core/config.js';
import { WhatsAppConnection } from './core/connection.js';
import { startHealthServer } from './core/health.js';
import { startHeartbeat } from './core/heartbeat.js';
import { createLogger } from './core/logger.js';
import { JobQueue } from './core/queue.js';
import { stickerCommand } from './features/sticker/sticker.command.js';

function main(): void {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const logger = createLogger(config.logLevel);
  logger.info({ commit: config.commit, node: process.version }, 'Litrizz-V7 iniciando');

  const queue = new JobQueue(config.maxConcurrentJobs, config.maxQueue);
  const auth = new AuthStore(config.authDir, config.authBackupDir, logger);

  const registry = new CommandRegistry()
    .register(stickerCommand)
    .register(pingCommand)
    .register(helpCommand)
    .register(statusCommand)
    .register(logsCommand)
    .register(restartCommand)
    .register(updateCommand)
    .register(rollbackCommand);

  let shuttingDown = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn({ reason, exitCode }, 'encerrando');
    clearInterval(heartbeat);
    healthServer.close();
    await connection.stop();
    await queue.drain(15_000);
    await auth.maybeBackup(true).catch(() => undefined);
    process.exit(exitCode);
  };

  const control = new FileControlService({
    controlDir: config.controlDir,
    commit: config.commit,
    startedAt: Date.now(),
    getHealth: () => connection.health(),
    getQueueStats: () => queue.stats,
  });

  const services: Services = {
    config,
    logger,
    queue,
    control,
    listCommands: () => registry.all(),
    shutdown,
  };
  const router = new CommandRouter(registry, services);

  const notifyFinishedActions = async (sock: WASocket): Promise<void> => {
    for (const { request, result } of await control.collectFinished()) {
      const text = `${result.ok ? '✅' : '❌'} ${request.action}: ${result.message}\nVersão atual: ${config.commit}`;
      await sock.sendMessage(request.replyJid, { text });
      await control.acknowledge(request.id);
    }
  };

  const connection = new WhatsAppConnection(config, logger, auth, {
    onMessages: (sock: WASocket, messages: WAMessage[]) => {
      for (const msg of messages) router.handle(sock, msg);
    },
    onOpen: (sock: WASocket) => {
      notifyFinishedActions(sock).catch((err: unknown) => logger.warn({ err }, 'falha ao avisar resultado'));
    },
    onFatal: (reason: string) => void shutdown(reason, 1),
  });

  const healthServer = startHealthServer(() => connection.health(), logger);
  if (config.kumaPushUrl) heartbeat = startHeartbeat(config.kumaPushUrl, () => connection.health(), logger);

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException', 1);
  });

  control
    .init()
    .then(() => connection.start())
    .catch((err: unknown) => {
      logger.fatal({ err }, 'falha na inicialização');
      void shutdown('startup failure', 1);
    });
}

main();
