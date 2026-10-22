import type { Logger } from 'pino';
import type { HealthInfo } from './connection.js';

export function startHeartbeat(pushUrl: string, getHealth: () => HealthInfo, logger: Logger): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    const health = getHealth();
    try {
      const url = new URL(pushUrl);
      url.searchParams.set('status', health.ok ? 'up' : 'down');
      url.searchParams.set('msg', health.state);
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      logger.debug({ err }, 'heartbeat falhou');
    }
  };
  void tick();
  return setInterval(() => void tick(), 60_000);
}
