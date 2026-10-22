import http from 'node:http';
import type { Logger } from 'pino';
import type { HealthInfo } from './connection.js';

export const HEALTH_PORT = 3000;

export function startHealthServer(getHealth: () => HealthInfo, logger: Logger): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const health = getHealth();
    res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health));
  });
  server.on('error', (err) => logger.error({ err }, 'servidor de health falhou'));
  server.listen(HEALTH_PORT, '127.0.0.1');
  return server;
}
