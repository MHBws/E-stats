// =============================================================================
// src/core/match.service.ts — Serviço de Leitura de Partidas (Home Screen & Detalhe)
// -----------------------------------------------------------------------------
// O QUE: Consulta o PostgreSQL com queries SQL parametrizadas e JOINs entre
//        `matches`, `tournaments`, `teams` e `match_maps`, retornando DTOs
//        aninhados prontos para renderização dos cards estilo Apple Sports.
// POR QUE (Otimização Mobile / Padrão BFF):
//   1. Eliminação de N+1 na Rede Móvel: Em vez de retornar apenas IDs
//      (`team_a_id`, `tournament_id`) e obrigar o celular em 4G/5G a disparar
//      dezenas de requisições extras para montar a Home Screen, o Postgres
//      resolve o JOIN localmente em <1ms e entrega o card completo em 1 request.
//   2. Payload Enxuto: Selecionamos apenas os campos visuais necessários para
//      o card (nome, sigla `acronym`, `logo_url`, `tier`), reduzindo bytes
//      trafegados e consumo de bateria no parse JSON do iOS/Android.
//   3. Segurança e Performance no Banco: Filtros usam bind parameters (`$1`,
//      `$2`) prevenindo SQL Injection e aproveitando o cache de planos de
//      execução e os índices compostos (`matches_status_scheduled_idx`).
// =============================================================================
import type pg from 'pg';
import { db } from './database.js';
import type {
  MapStatus,
  MatchFormat,
  MatchStatus,
  TournamentTier,
  UUID,
} from './models.js';
// [UPDATE]: Integra `PandaScoreAdapter` para enriquecer `GET /api/matches/:id`
// com rosters reais (`players`), placar consolidado (`results`) e `players_stats`.
import {
  PandaScoreAdapter,
  type PandaScorePostMatchPlayerStat,
  type PandaScoreRosterPlayer,
  type PreMatchStatsDto,
} from '../providers/pandascore/pandascore.adapter.js';
// [UPDATE]: Aciona handoff imediato e hidratação sob demanda na Cito Sports
// quando uma partida está `live`, alinhando os IDs entre REST, Redis e WebSocket.
import {
  ensureLiveMatchHydrated,
  handoffLiveMatchesToCito,
} from '../workers/cron.manager.js';

/** Abas estilo Apple Sports suportadas pelo filtro de listagem. */
export type MatchTabFilter = 'yesterday' | 'today' | 'upcoming';

/** Filtros aceitos pela listagem da Home Screen (`GET /api/matches`). */
export interface MatchListFilters {
  status?: string;
  /** Data no formato ISO `YYYY-MM-DD` (UTC). */
  date?: string;
  // [UPDATE]: Suporte opcional ao filtro por aba (`?tab=yesterday|today|upcoming`).
  tab?: MatchTabFilter;
}

/** Resumo do campeonato embutido no card da partida. */
export interface MatchTournamentSummary {
  id: UUID;
  name: string;
  tier: TournamentTier | null;
}

/** Resumo de uma equipe embutido no card da partida (`null` se ainda "TBD"). */
export interface MatchTeamSummary {
  id: UUID;
  name: string;
  acronym: string | null;
  logo_url: string | null;
  // [UPDATE]: Elenco de jogadores retornado no detalhe da partida (`GET /api/matches/:id`).
  players?: PandaScoreRosterPlayer[];
}

/** Placar consolidado da série (mapas vencidos por cada equipe). */
export interface MatchSeriesResultsDto {
  team_a_score: number;
  team_b_score: number;
}

/**
 * Formato aninhado de uma partida para os Cards da Home Screen.
 * Mantém chaves em snake_case (`team_a`, `team_b`, `scheduled_at`) no contrato
 * REST público conforme especificação para os clientes iOS/Android.
 */
export interface MatchCardDto {
  id: UUID;
  format: MatchFormat;
  status: MatchStatus;
  scheduled_at: string;
  winner_id: UUID | null;
  // [UPDATE]: Placar geral da série unificado entre `MatchCardDto` (Home) e `MatchDetailDto` (Detalhes).
  results: MatchSeriesResultsDto;
  tournament: MatchTournamentSummary;
  team_a: MatchTeamSummary | null;
  team_b: MatchTeamSummary | null;
}

/** Item da lista de mapas (veto/pick) no detalhe da partida. */
export interface MatchMapDetailDto {
  id: UUID;
  map_number: number;
  map_name: string;
  pick_team_id: UUID | null;
  status: MapStatus;
  team_a_score: number;
  team_b_score: number;
}

/** Detalhe completo da partida (`GET /api/matches/:id`), incluindo mapas, rosters e stats. */
export interface MatchDetailDto extends MatchCardDto {
  maps: MatchMapDetailDto[];
  // [UPDATE]: Placar final consolidado da série, estatísticas pós-jogo e dados avançados pré-jogo (H2H, Form, Standings, Streams).
  results: MatchSeriesResultsDto;
  players_stats: PandaScorePostMatchPlayerStat[];
  preMatchStats: PreMatchStatsDto;
  // [UPDATE]: Mapeamento explícito de IDs para subscrição WebSocket sem conflito
  // entre UUID canônico, Cito Sports (`cs2-match-XXXX`) e PandaScore (inteiro).
  ws_match_id: UUID;
  cito_match_id: string | null;
  pandascore_match_id: string | null;
}

/** Linha bruta retornada pelo JOIN de `getMatches`. */
interface MatchJoinedRow {
  match_id: UUID;
  format: MatchFormat;
  status: MatchStatus;
  scheduled_at: Date;
  winner_id: UUID | null;
  team_a_maps_won?: number | string | null;
  team_b_maps_won?: number | string | null;
  tournament_id: UUID;
  tournament_name: string;
  tournament_tier: TournamentTier | null;
  team_a_id: UUID | null;
  team_a_name: string | null;
  team_a_acronym: string | null;
  team_a_logo_url: string | null;
  team_b_id: UUID | null;
  team_b_name: string | null;
  team_b_acronym: string | null;
  team_b_logo_url: string | null;
}

/** Linha bruta retornada pelo JOIN de `getMatchById` (inclui colunas de `match_maps`). */
interface MatchDetailJoinedRow extends MatchJoinedRow {
  map_id: UUID | null;
  map_number: number | null;
  map_name: string | null;
  map_pick_team_id: UUID | null;
  map_status: MapStatus | null;
  map_team_a_score: number | null;
  map_team_b_score: number | null;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Calcula o placar da série (`results`) de forma unificada a partir dos mapas vencidos ou `winner_id`. */
function resolveSeriesResults(params: {
  status: MatchStatus;
  format: MatchFormat;
  winnerId: UUID | null;
  teamAId: UUID | null;
  teamBId: UUID | null;
  teamAMapsWon: number;
  teamBMapsWon: number;
}): MatchSeriesResultsDto {
  let scoreA = params.teamAMapsWon;
  let scoreB = params.teamBMapsWon;

  if (params.status === 'finished' && scoreA === 0 && scoreB === 0) {
    const targetWins = params.format === 'BO1' ? 1 : params.format === 'BO5' ? 3 : 2;
    if (params.winnerId && params.winnerId === params.teamAId) {
      scoreA = targetWins;
    } else if (params.winnerId && params.winnerId === params.teamBId) {
      scoreB = targetWins;
    }
  }

  return {
    team_a_score: scoreA,
    team_b_score: scoreB,
  };
}

/** Converte uma linha plana do SQL JOIN para o objeto aninhado `MatchCardDto`. */
function mapRowToMatchCard(row: MatchJoinedRow): MatchCardDto {
  const teamAMapsWon = Number(row.team_a_maps_won ?? 0) || 0;
  const teamBMapsWon = Number(row.team_b_maps_won ?? 0) || 0;

  return {
    id: row.match_id,
    format: row.format,
    status: row.status,
    scheduled_at:
      row.scheduled_at instanceof Date
        ? row.scheduled_at.toISOString()
        : new Date(row.scheduled_at).toISOString(),
    winner_id: row.winner_id,
    results: resolveSeriesResults({
      status: row.status,
      format: row.format,
      winnerId: row.winner_id,
      teamAId: row.team_a_id,
      teamBId: row.team_b_id,
      teamAMapsWon,
      teamBMapsWon,
    }),
    tournament: {
      id: row.tournament_id,
      name: row.tournament_name,
      tier: row.tournament_tier,
    },
    team_a:
      row.team_a_id && row.team_a_name
        ? {
            id: row.team_a_id,
            name: row.team_a_name,
            acronym: row.team_a_acronym,
            logo_url: row.team_a_logo_url,
          }
        : null,
    team_b:
      row.team_b_id && row.team_b_name
        ? {
            id: row.team_b_id,
            name: row.team_b_name,
            acronym: row.team_b_acronym,
            logo_url: row.team_b_logo_url,
          }
        : null,
  };
}

export class MatchService {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'> = db,
    private readonly pandaAdapter: PandaScoreAdapter = new PandaScoreAdapter(),
  ) {}

  /**
   * Lista partidas para a Home Screen com suporte a filtros opcionais (`status` e `date`).
   * POR QUE usamos `LEFT JOIN` em `teams`: Em chaves de playoffs, uma partida já tem
   * horário e campeonato definidos mesmo enquanto aguarda o vencedor da fase anterior
   * (`team_a_id` ou `team_b_id` = NULL, exibido como "TBD" no app). Um `INNER JOIN`
   * esconderia essas partidas da tela inicial.
   */
  async getMatches(filters?: MatchListFilters): Promise<MatchCardDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      params.push(filters.status);
      conditions.push(`m.status = $${params.length}`);
    }

    if (filters?.date) {
      if (!ISO_DATE_REGEX.test(filters.date)) {
        throw new Error(`[match.service] Formato de data inválido (use YYYY-MM-DD): ${filters.date}`);
      }
      // Filtro por intervalo [início do dia, início do dia seguinte) em vez de
      // `DATE(m.scheduled_at) = $N`: mantém a query SARGable para que o Postgres
      // use o índice `matches_status_scheduled_idx` sem fazer Seq Scan na tabela.
      params.push(filters.date);
      const idx = params.length;
      conditions.push(
        `m.scheduled_at >= ($${idx}::date AT TIME ZONE 'UTC') AND m.scheduled_at < (($${idx}::date + INTERVAL '1 day') AT TIME ZONE 'UTC')`,
      );
    } else if (filters?.tab === 'yesterday') {
      // [UPDATE]: Aba "Ontem" via querystring: partidas finalizadas recentes (últimos 4 dias)
      // ou agendadas estritamente antes do dia atual.
      conditions.push(
        `(m.status = 'finished' OR m.scheduled_at < DATE_TRUNC('day', NOW())) AND m.scheduled_at >= NOW() - INTERVAL '4 days'`,
      );
    } else if (filters?.tab === 'today') {
      // [UPDATE]: Aba "Hoje" via querystring: partidas ao vivo ou agendadas para a data atual.
      conditions.push(
        `(m.status = 'live' OR (m.scheduled_at >= DATE_TRUNC('day', NOW()) AND m.scheduled_at < DATE_TRUNC('day', NOW()) + INTERVAL '1 day'))`,
      );
    } else if (filters?.tab === 'upcoming') {
      // [UPDATE]: Aba "Próximos" via querystring: partidas agendadas após o dia de hoje.
      conditions.push(
        `m.scheduled_at >= DATE_TRUNC('day', NOW()) + INTERVAL '1 day' AND m.status NOT IN ('live', 'finished')`,
      );
    } else if (!filters?.status) {
      // [UPDATE]: Opção A (Padrão para UX instantânea no Mobile): retorna todas as
      // partidas na janela de D-4 até D+7 (além de qualquer jogo `live`), permitindo
      // que o app alterne entre "Ontem", "Hoje" e "Próximos" em memória com latência zero.
      conditions.push(
        `(m.status = 'live' OR (m.scheduled_at >= NOW() - INTERVAL '4 days' AND m.scheduled_at <= NOW() + INTERVAL '7 days'))`,
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Ordenação pensada para UX estilo Apple Sports: partidas AO VIVO sempre no
    // topo da tela, seguidas pelas agendadas em ordem cronológica.
    const sql = `
      SELECT
        m.id            AS match_id,
        m.format        AS format,
        m.status        AS status,
        m.scheduled_at  AS scheduled_at,
        m.winner_id     AS winner_id,
        COALESCE(ms.team_a_maps_won, 0) AS team_a_maps_won,
        COALESCE(ms.team_b_maps_won, 0) AS team_b_maps_won,
        t.id            AS tournament_id,
        t.name          AS tournament_name,
        t.tier          AS tournament_tier,
        ta.id           AS team_a_id,
        ta.name         AS team_a_name,
        ta.acronym      AS team_a_acronym,
        ta.logo_url     AS team_a_logo_url,
        tb.id           AS team_b_id,
        tb.name         AS team_b_name,
        tb.acronym      AS team_b_acronym,
        tb.logo_url     AS team_b_logo_url
      FROM matches m
      INNER JOIN tournaments t ON t.id = m.tournament_id
      LEFT JOIN teams ta       ON ta.id = m.team_a_id
      LEFT JOIN teams tb       ON tb.id = m.team_b_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE mm.status = 'finished' AND mm.team_a_score > mm.team_b_score)::int AS team_a_maps_won,
          COUNT(*) FILTER (WHERE mm.status = 'finished' AND mm.team_b_score > mm.team_a_score)::int AS team_b_maps_won
        FROM match_maps mm
        WHERE mm.match_id = m.id
      ) ms ON TRUE
      ${whereClause}
      ORDER BY
        CASE m.status
          WHEN 'live'      THEN 0
          WHEN 'scheduled' THEN 1
          ELSE 2
        END ASC,
        m.scheduled_at ASC
    `;

    const result = await this.pool.query<MatchJoinedRow>(sql, params);
    return result.rows.map(mapRowToMatchCard);
  }

  /**
   * Busca os detalhes completos de uma partida específica pelo UUID, fazendo
   * JOIN também com `match_maps` para retornar a sequência de mapas do veto.
   * Retorna `null` se o ID não for um UUID válido ou não existir no banco.
   */
  async getMatchById(id: string): Promise<MatchDetailDto | null> {
    // Valida formato UUID antes de consultar o banco para evitar erro 22P02 do Postgres.
    if (!UUID_REGEX.test(id)) {
      return null;
    }

    const sql = `
      SELECT
        m.id              AS match_id,
        m.format          AS format,
        m.status          AS status,
        m.scheduled_at    AS scheduled_at,
        m.winner_id       AS winner_id,
        t.id              AS tournament_id,
        t.name            AS tournament_name,
        t.tier            AS tournament_tier,
        ta.id             AS team_a_id,
        ta.name           AS team_a_name,
        ta.acronym        AS team_a_acronym,
        ta.logo_url       AS team_a_logo_url,
        tb.id             AS team_b_id,
        tb.name           AS team_b_name,
        tb.acronym        AS team_b_acronym,
        tb.logo_url       AS team_b_logo_url,
        mm.id             AS map_id,
        mm.map_number     AS map_number,
        mm.map_name       AS map_name,
        mm.pick_team_id   AS map_pick_team_id,
        mm.status         AS map_status,
        mm.team_a_score   AS map_team_a_score,
        mm.team_b_score   AS map_team_b_score
      FROM matches m
      INNER JOIN tournaments t ON t.id = m.tournament_id
      LEFT JOIN teams ta       ON ta.id = m.team_a_id
      LEFT JOIN teams tb       ON tb.id = m.team_b_id
      LEFT JOIN match_maps mm  ON mm.match_id = m.id
      WHERE m.id = $1
      ORDER BY mm.map_number ASC
    `;

    const result = await this.pool.query<MatchDetailJoinedRow>(sql, [id]);
    const firstRow = result.rows[0];
    if (!firstRow) {
      return null;
    }

    const baseCard = mapRowToMatchCard(firstRow);

    // [UPDATE]: Suporte ao Smart Polling mobile — se a partida ainda consta como
    // `'scheduled'` no banco mas já entrou na janela de início (<= 15 min ou já passou),
    // verifica o status fresco na PandaScore (com throttle de 12s). Se virou `'live'`,
    // atualiza o Postgres e dispara o handoff imediato para a Cito Sports.
    if (baseCard.status === 'scheduled') {
      const freshStatus = await this.pandaAdapter.refreshImminentMatchStatus({
        matchId: baseCard.id,
        currentStatus: baseCard.status,
        scheduledAtIso: baseCard.scheduled_at,
      });
      if (freshStatus !== baseCard.status) {
        baseCard.status = freshStatus;
        if (freshStatus === 'live') {
          void handoffLiveMatchesToCito([baseCard.id]).catch(() => {
            // O watchdog de 1m atua como fallback caso o handoff falhe.
          });
        }
      }
    }

    const maps: MatchMapDetailDto[] = [];

    for (const row of result.rows) {
      if (
        row.map_id !== null &&
        row.map_number !== null &&
        row.map_name !== null &&
        row.map_status !== null
      ) {
        maps.push({
          id: row.map_id,
          map_number: row.map_number,
          map_name: row.map_name,
          pick_team_id: row.map_pick_team_id,
          status: row.map_status,
          team_a_score: row.map_team_a_score ?? 0,
          team_b_score: row.map_team_b_score ?? 0,
        });
      }
    }

    // [UPDATE]: Unifica o cálculo de `results` usando exatamente `resolveSeriesResults`.
    const results = resolveSeriesResults({
      status: baseCard.status,
      format: baseCard.format,
      winnerId: baseCard.winner_id,
      teamAId: baseCard.team_a?.id ?? null,
      teamBId: baseCard.team_b?.id ?? null,
      teamAMapsWon: maps.filter((m) => m.status === 'finished' && m.team_a_score > m.team_b_score).length,
      teamBMapsWon: maps.filter((m) => m.status === 'finished' && m.team_b_score > m.team_a_score).length,
    });

    const teamARef = baseCard.team_a
      ? {
          id: baseCard.team_a.id,
          name: baseCard.team_a.name,
          acronym: baseCard.team_a.acronym,
        }
      : null;
    const teamBRef = baseCard.team_b
      ? {
          id: baseCard.team_b.id,
          name: baseCard.team_b.name,
          acronym: baseCard.team_b.acronym,
        }
      : null;

    // [UPDATE]: Dispara simultaneamente (`Promise.all`) a busca de rosters/stats,
    // o enriquecimento relacional `preMatchStats` e (para partidas `live`) a
    // hidratação sob demanda na Cito Sports (`ensureLiveMatchHydrated`) para que
    // o Redis já contenha `CS2LiveState` antes da conexão WebSocket do cliente.
    const [
      { teamAPlayers, teamBPlayers, playersStats },
      preMatchStats,
      hydratedCitoId,
    ] = await Promise.all([
      this.pandaAdapter.fetchMatchRostersAndStats({
        matchId: baseCard.id,
        status: baseCard.status,
        winnerId: baseCard.winner_id,
        teamA: teamARef,
        teamB: teamBRef,
        mapsCount: maps.filter((m) => m.status === 'finished').length || maps.length,
      }),
      this.pandaAdapter.fetchPreMatchStats({
        matchId: baseCard.id,
        tournamentId: baseCard.tournament.id,
        teamA: teamARef,
        teamB: teamBRef,
      }),
      baseCard.status === 'live'
        ? ensureLiveMatchHydrated(baseCard.id)
        : Promise.resolve<string | null>(null),
    ]);

    // [UPDATE]: Consulta `provider_mappings` após a hidratação para expor
    // `cito_match_id`, `pandascore_match_id` e `ws_match_id` no payload REST.
    const providerMappingsResult = await this.pool.query<{
      provider: string;
      external_id: string;
    }>(
      `SELECT provider, external_id
         FROM provider_mappings
        WHERE entity_type = 'match'
          AND entity_id = $1`,
      [baseCard.id],
    );

    const citoMatchId =
      hydratedCitoId ??
      providerMappingsResult.rows.find((r) => r.provider === 'cito')?.external_id ??
      null;
    const pandascoreMatchId =
      providerMappingsResult.rows.find((r) => r.provider === 'pandascore')?.external_id ??
      null;

    return {
      ...baseCard,
      team_a: baseCard.team_a
        ? {
            ...baseCard.team_a,
            players: teamAPlayers,
          }
        : null,
      team_b: baseCard.team_b
        ? {
            ...baseCard.team_b,
            players: teamBPlayers,
          }
        : null,
      maps,
      results,
      players_stats: playersStats,
      preMatchStats,
      ws_match_id: baseCard.id,
      cito_match_id: citoMatchId,
      pandascore_match_id: pandascoreMatchId,
    };
  }
}

/** Instância singleton padrão + funções exportadas diretamente conforme especificação. */
export const matchService = new MatchService();

export const getMatches = (filters?: MatchListFilters): Promise<MatchCardDto[]> =>
  matchService.getMatches(filters);

export const getMatchById = (id: string): Promise<MatchDetailDto | null> =>
  matchService.getMatchById(id);
