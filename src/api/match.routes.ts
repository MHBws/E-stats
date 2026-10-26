// =============================================================================
// src/api/match.routes.ts — Rotas REST de Partidas (Home Screen & Detalhes)
// -----------------------------------------------------------------------------
// O QUE: Plugin Fastify que expõe `GET /matches` (listagem com filtros para os
//        cards da Home Screen) e `GET /matches/:id` (detalhe da série + mapas
//        do veto). Quando registrado com prefixo `/api` no `server.ts`, responde
//        em `/api/matches` e `/api/matches/:id`.
// POR QUE: Enquanto o placar de rounds ao vivo trafega via WebSocket (`/ws/live/:matchId`),
//          o carregamento inicial da Home Screen (lista de jogos do dia, status,
//          logos dos times e torneio) e a tela de detalhes pré-jogo são melhor
//          atendidos por HTTP REST — permitindo cache HTTP e paginação/filtros
//          simples no cliente mobile.
// =============================================================================
import type { FastifyInstance } from 'fastify';
import { MatchService, matchService } from '../core/match.service.js';

export interface MatchesQuerystring {
  status?: string;
  date?: string;
}

export interface MatchParams {
  id: string;
}

export async function matchRoutes(
  app: FastifyInstance,
  options?: { service?: MatchService },
): Promise<void> {
  const service = options?.service ?? matchService;

  // ---------------------------------------------------------------------------
  // GET /matches — Lista partidas para a Home Screen (filtros: ?status=&date=)
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: MatchesQuerystring }>('/matches', async (request, reply) => {
    const { status, date } = request.query;

    try {
      const matches = await service.getMatches({ status, date });
      return reply.code(200).send(matches);
    } catch (err) {
      request.log.error({ err, status, date }, '[api] Erro ao listar partidas em GET /matches');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Falha ao buscar a lista de partidas.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /matches/:id — Detalhe de uma partida específica + mapas do veto
  // ---------------------------------------------------------------------------
  app.get<{ Params: MatchParams }>('/matches/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const match = await service.getMatchById(id);
      if (!match) {
        return reply.code(404).send({
          error: 'Not Found',
          message: `Partida '${id}' não encontrada.`,
        });
      }

      return reply.code(200).send(match);
    } catch (err) {
      request.log.error({ err, id }, '[api] Erro ao buscar detalhe da partida em GET /matches/:id');
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Falha ao buscar os detalhes da partida.',
      });
    }
  });
}
