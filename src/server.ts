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
// [UPDATE]: Módulo 5 — Rotas REST de partidas (`/api/matches` e `/api/matches/:id`)
// para alimentar os cards estilo Apple Sports da Home Screen mobile.
import { matchRoutes } from './api/match.routes.js';
// [UPDATE]: Módulo 3 — Injeção de dependência do MappingService nos Adapters
// (PandaScore REST e Cito Live Stream) para isolar o domínio de Esports.
import { MappingService } from './core/mapping.service.js';
import { PandaScoreAdapter } from './providers/pandascore/pandascore.adapter.js';
import { CitoAdapter } from './providers/cito/cito.adapter.js';

const app = Fastify({
  logger: { level: env.logLevel },
});

// [UPDATE]: Instanciação centralizada do serviço de mapeamento e dos adapters.
const mappingService = new MappingService();
const pandaScoreAdapter = new PandaScoreAdapter(mappingService);
const citoAdapter = new CitoAdapter(mappingService);

async function bootstrap(): Promise<void> {
  // Plugin de WebSocket (baseado na lib `ws`) deve ser registrado antes das rotas.
  await app.register(websocket);

  // Rotas HTTP e WebSocket.
  await app.register(healthRoutes);
  await app.register(liveWsRoutes);
  // [UPDATE]: Módulo 5 — Registra os endpoints REST sob o prefixo `/api`.
  await app.register(matchRoutes, { prefix: '/api' });

  // Redis é obrigatório para o placar ao vivo: conecta antes de aceitar tráfego.
  await connectRedis();

  // [UPDATE]: Módulo 3 — Inicializa os adapters de provedores externos e
  // registra no log a prontidão da camada anticorrupção.
  const upcomingPreview = await pandaScoreAdapter.fetchUpcomingMatches();
  app.log.info(
    {
      providers: [pandaScoreAdapter.providerId, citoAdapter.providerId],
      upcomingMatchesSimulated: upcomingPreview.length,
    },
    '[providers] Adapters PandaScore e Cito inicializados com MappingService',
  );

  await app.listen({ host: env.host, port: env.port });
}

/** Encerra servidor e conexões de forma ordenada. */
async function shutdown(signal: string): Promise<void> {
  app.log.info(`[server] Sinal ${signal} recebido, encerrando...`);
  try {
    // [UPDATE]: Módulo 3 — Encerra streams ativos da Cito antes de fechar o Redis.
    citoAdapter.disconnectAll();
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
