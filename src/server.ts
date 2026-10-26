// =============================================================================
// src/server.ts — Ponto de entrada (bootstrap) da API
// -----------------------------------------------------------------------------
// O QUE: Inicializa o Fastify, registra plugins/rotas, conecta ao Redis e
//        sobe o servidor HTTP + WebSocket. Também trata o shutdown gracioso.
// POR QUE: Fastify foi escolhido pelo baixíssimo overhead por requisição e
//          pelo logger (Pino) assíncrono — ambos importantes para latência.
//          O shutdown gracioso evita conexões órfãs durante o hot reload.
// =============================================================================
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { env } from './config/env.js';
import { closeDatabase } from './core/database.js';
import { closeRedis, connectRedis } from './core/redis.js';
import { healthRoutes } from './api/health.routes.js';
import { liveWsRoutes } from './api/live.ws.js';

const app = Fastify({
  logger: { level: env.logLevel },
});

async function bootstrap(): Promise<void> {
  // Plugin de WebSocket (baseado na lib `ws`) deve ser registrado antes das rotas.
  await app.register(websocket);

  // Rotas HTTP e WebSocket.
  await app.register(healthRoutes);
  await app.register(liveWsRoutes);

  // Redis é obrigatório para o placar ao vivo: conecta antes de aceitar tráfego.
  await connectRedis();

  await app.listen({ host: env.host, port: env.port });
}

/** Encerra servidor e conexões de forma ordenada. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`[server] Sinal ${signal} recebido, encerrando...`);
  try {
    await app.close(); // para de aceitar conexões e fecha os WebSockets
    await Promise.allSettled([closeRedis(), closeDatabase()]);
    process.exit(0);
  } catch (err) {
    app.log.error(err, '[server] Erro durante o shutdown');
    process.exit(1);
  }
}

// SIGTERM: enviado pelo Docker no `stop`; SIGINT: Ctrl+C / reinício do nodemon.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

bootstrap().catch((err: unknown) => {
  app.log.error(err, '[server] Falha ao iniciar a aplicação');
  process.exit(1);
});
