import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import qrcode from 'qrcode-terminal';
import type { AuthStore } from './auth-store.js';
import type { AppConfig } from './config.js';

export type ConnectionState =
  | 'starting'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'needs_pairing'
  | 'logged_out'
  | 'stopped';

export interface HealthInfo {
  readonly ok: boolean;
  readonly state: ConnectionState;
  readonly disconnectedForSec: number;
}

export interface ConnectionHandlers {
  onMessages(sock: WASocket, messages: WAMessage[]): void;
  onOpen(sock: WASocket): void;
  onFatal(reason: string): void;
}

const GRACE_BEFORE_UNHEALTHY_MS = 3 * 60_000;

function statusCodeOf(error: unknown): number | undefined {
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === 'number' ? code : undefined;
}


export class WhatsAppConnection {
  readonly startedAt = Date.now();
  private currentState: ConnectionState = 'starting';
  private current: WASocket | null = null;
  private attempts = 0;
  private disconnectedSince: number | null = Date.now();
  private halted = false;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private credsWrites: Promise<void> = Promise.resolve();
  private watchdogTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly auth: AuthStore,
    private readonly handlers: ConnectionHandlers,
  ) { }

  get state(): ConnectionState {
    return this.currentState;
  }

  get socket(): WASocket | null {
    return this.currentState === 'open' ? this.current : null;
  }

  health(): HealthInfo {
    const downFor = this.disconnectedSince === null ? 0 : Date.now() - this.disconnectedSince;
    const transient =
      this.currentState === 'starting' || this.currentState === 'connecting' || this.currentState === 'reconnecting';
    return {
      ok: this.currentState === 'open' || (transient && downFor < GRACE_BEFORE_UNHEALTHY_MS),
      state: this.currentState,
      disconnectedForSec: Math.round(downFor / 1000),
    };
  }

  async start(): Promise<void> {
    this.watchdogTimer = setInterval(() => this.checkWatchdog(), 30_000);
    await this.connect().catch((err: unknown) => {
      this.logger.error({ err }, 'falha ao iniciar conexão');
      this.scheduleReconnect();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.watchdogTimer);
    clearTimeout(this.reconnectTimer);
    this.setState('stopped');
    try {
      this.current?.end(undefined);
    } catch {
    }
  }

  private setState(next: ConnectionState): void {
    if (next === this.currentState) return;
    if (next === 'open') this.disconnectedSince = null;
    else if (this.currentState === 'open' || this.disconnectedSince === null) this.disconnectedSince = Date.now();
    this.logger.info({ from: this.currentState, to: next }, 'estado da conexão');
    this.currentState = next;
  }

  private checkWatchdog(): void {
    const s = this.currentState;
    if (s === 'open' || s === 'logged_out' || s === 'needs_pairing' || s === 'stopped') return;
    if (this.disconnectedSince !== null && Date.now() - this.disconnectedSince > this.config.watchdogMs) {
      this.handlers.onFatal(`watchdog: sem conexão há mais de ${Math.round(this.config.watchdogMs / 60_000)} min`);
    }
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopping || this.halted) return;
    const base = Math.min(60_000, 1000 * 2 ** this.attempts);
    const delay = immediate ? 0 : Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempts++;
    this.setState('reconnecting');
    this.logger.info({ delayMs: delay, attempt: this.attempts }, 'reconectando');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err: unknown) => {
        this.logger.error({ err }, 'falha ao reconectar');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopping || this.halted) return;
    this.setState('connecting');
    await this.credsWrites; // espera qualquer gravação pendente (ex.: logo após o pareamento)
    await this.auth.ensureValid();
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

    const sock = makeWASocket({
      auth: state,
      logger: this.logger.child({ module: 'baileys' }, { level: 'warn' }),
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.current = sock;
    let pairingRequested = false;

    sock.ev.on('creds.update', () => {
      if (this.current !== sock) return;
      this.credsWrites = this.credsWrites
        .then(() => saveCreds())
        .then(() => this.auth.maybeBackup())
        .catch((err: unknown) => this.logger.error({ err }, 'falha ao salvar credenciais'));
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.current !== sock || type !== 'notify') return;
      this.handlers.onMessages(sock, messages);
    });

    sock.ev.on('connection.update', (update) => {
      if (this.current !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        if (this.config.pairingMode === 'qr') {
          this.showQr(qr);
        } else if (!pairingRequested) {
          pairingRequested = true;
          void this.requestPairing(sock);
        }
      }

      if (connection === 'open') {
        this.attempts = 0;
        this.setState('open');
        this.logger.info({ user: sock.user?.id }, 'conectado ao WhatsApp');
        void this.auth.maybeBackup();
        this.handlers.onOpen(sock);
        return;
      }

      if (connection === 'close') {
        const code = statusCodeOf(lastDisconnect?.error);
        this.logger.warn({ code }, 'conexão fechada');
        if (code === DisconnectReason.loggedOut) {
          this.halted = true;
          this.setState('logged_out');
          this.logger.error('O WhatsApp encerrou esta sessão (logout). Rode ./ctl pair para parear de novo.');
          return;
        }
        if (this.halted || this.stopping) return;
        if (this.currentState === 'open') this.setState('reconnecting');
        this.scheduleReconnect(code === DisconnectReason.restartRequired);
      }
    });
  }

  private showQr(qr: string): void {
    this.setState('needs_pairing');
    this.logger.warn('ESCANEIE O QR CODE ABAIXO — WhatsApp > Aparelhos conectados > Conectar um aparelho');
    qrcode.generate(qr, { small: true });
  }

  private async requestPairing(sock: WASocket): Promise<void> {
    const phone = this.config.phone;
    if (!phone) {
      this.halted = true;
      this.setState('needs_pairing');
      this.logger.error('Sessão não pareada e WHATSAPP_PHONE não está no .env. Defina e rode ./ctl pair.');
      try {
        sock.end(undefined);
      } catch {
      }
      return;
    }
    try {
      const code = await sock.requestPairingCode(phone);
      const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
      this.setState('needs_pairing');
      this.logger.warn(
        `CÓDIGO DE PAREAMENTO: ${pretty} — WhatsApp > Aparelhos conectados > Conectar com número de telefone` +
        ` (número usado: ${phone.slice(0, 4)}…${phone.slice(-2)}, ${phone.length} dígitos)`,
      );
    } catch (err) {
      this.logger.error({ err }, 'não consegui gerar o código de pareamento');
    }
  }
}