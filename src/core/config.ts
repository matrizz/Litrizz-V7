import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const digitsList = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().replace(/\D/g, ''))
      .filter((s) => s.length > 0),
  );

const num = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

const schema = z.object({
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  COMMAND_PREFIX: z.string().min(1).max(3).default('.'),
  PAIRING_MODE: z.enum(['code', 'qr']).default('code'),
  WHATSAPP_PHONE: z
    .string()
    .regex(/^\d{10,15}$/, 'use só dígitos com DDI+DDD, ex.: 5513999999999')
    .optional(),
  ALLOWED_NUMBERS: digitsList,
  PACK_NAME: z.string().min(1).max(60).default('Sticker Bot'),
  PACK_AUTHOR: z.string().min(1).max(60).default('Sticker Bot'),
  DELETE_COMMAND_MESSAGE: bool.default('false'),
  MAX_CONCURRENT_JOBS: num(2),
  MAX_QUEUE: num(10, 0),
  JOB_TIMEOUT_SECONDS: num(60, 5),
  MAX_VIDEO_SECONDS: num(10, 1),
  MAX_INPUT_MB: num(25),
  MAX_ANIMATED_KB: num(800, 100),
  USER_COOLDOWN_SECONDS: num(3, 0),
  WATCHDOG_MINUTES: num(10, 1),
  KUMA_PUSH_URL: z.string().url().optional(),
});

export interface AppConfig {
  readonly dataDir: string;
  readonly authDir: string;
  readonly authBackupDir: string;
  readonly controlDir: string;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly prefix: string;
  readonly pairingMode: 'code' | 'qr';
  readonly phone: string | undefined;
  readonly allowedNumbers: readonly string[];
  readonly packName: string;
  readonly packAuthor: string;
  readonly deleteCommandMessage: boolean;
  readonly maxConcurrentJobs: number;
  readonly maxQueue: number;
  readonly jobTimeoutMs: number;
  readonly maxVideoSeconds: number;
  readonly maxInputBytes: number;
  readonly maxAnimatedBytes: number;
  readonly userCooldownMs: number;
  readonly watchdogMs: number;
  readonly kumaPushUrl: string | undefined;
  readonly commit: string;
}


export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {

  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuração inválida (.env):\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const dataDir = path.resolve(c.DATA_DIR);
  return {
    dataDir,
    authDir: path.join(dataDir, 'auth'),
    authBackupDir: path.join(dataDir, 'auth-backups'),
    controlDir: path.join(dataDir, 'control'),
    logLevel: c.LOG_LEVEL,
    prefix: c.COMMAND_PREFIX,
    pairingMode: c.PAIRING_MODE,
    phone: c.WHATSAPP_PHONE,
    allowedNumbers: c.ALLOWED_NUMBERS,
    packName: c.PACK_NAME,
    packAuthor: c.PACK_AUTHOR,
    deleteCommandMessage: c.DELETE_COMMAND_MESSAGE,
    maxConcurrentJobs: c.MAX_CONCURRENT_JOBS,
    maxQueue: c.MAX_QUEUE,
    jobTimeoutMs: c.JOB_TIMEOUT_SECONDS * 1000,
    maxVideoSeconds: c.MAX_VIDEO_SECONDS,
    maxInputBytes: c.MAX_INPUT_MB * 1024 * 1024,
    maxAnimatedBytes: c.MAX_ANIMATED_KB * 1024,
    userCooldownMs: c.USER_COOLDOWN_SECONDS * 1000,
    watchdogMs: c.WATCHDOG_MINUTES * 60_000,
    kumaPushUrl: c.KUMA_PUSH_URL,
    commit: env['GIT_COMMIT'] ?? 'dev',
  };
}