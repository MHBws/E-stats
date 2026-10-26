// =============================================================================
// src/api/health.routes.ts — Endpoint de saúde da aplicação
// -----------------------------------------------------------------------------
// O QUE: GET /health retorna o status da API e das dependências (DB e Redis).
// POR QUE: Permite verificar rapidamente se o ambiente subiu corretamente e
//          será usado futuramente por orquestradores/load balancers.
// =============================================================================
import type { FastifyInstance } from 'fastify';
import { pingDatabase } from '../core/database.js';
import { pingRedis } from '../core/redis.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    // Checagens em paralelo para não somar latências.
    const [database, redis] = await Promise.all([pingDatabase(), pingRedis()]);
    const healthy = database && redis;

    // 503 sinaliza degradação para quem consome o healthcheck.
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
    });
  });
}
