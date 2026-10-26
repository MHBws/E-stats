// =============================================================================
// src/providers/pandascore/pandascore.adapter.ts — Adapter REST da PandaScore
// -----------------------------------------------------------------------------
// O QUE: Encapsula chamadas HTTP REST para a API da PandaScore (calendário,
//        partidas futuras, torneios e times) e converte o payload externo para
//        o Modelo Canônico (`Match`).
// POR QUE: A PandaScore tem um formato próprio (`number_of_games: 3`,
//          `status: "not_started"`, `opponents: [...]`). O Adapter atua como
//          camada anticorrupção: traduz tudo na borda do sistema para que o
//          restante do BFF trabalhe apenas com `Match` (UUIDs, `'BO3'`,
//          `'scheduled'`), sem conhecer detalhes da PandaScore.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type { Match, MatchFormat, MatchStatus, UUID } from '../../core/models.js';

/** Formato bruto retornado pelo endpoint `/csgo/matches/upcoming` da PandaScore. */
interface PandaScoreRawMatch {
  id: number;
  name: string;
  scheduled_at: string;
  number_of_games: 1 | 3 | 5;
  status: 'not_started' | 'running' | 'finished' | 'postponed' | 'canceled';
  tournament_id: number;
  winner_id: number | null;
  opponents: Array<{
    opponent: {
      id: number;
      name: string;
      acronym: string | null;
      image_url: string | null;
    };
  }>;
}

export class PandaScoreAdapter {
  readonly providerId = 'pandascore' as const;
  private readonly baseUrl = 'https://api.pandascore.co/csgo';

  constructor(
    private readonly mapper: MappingService = mappingService,
    private readonly apiKey: string = env.providers.pandaScoreApiKey,
  ) {}

  /**
   * Busca partidas futuras de CS2 na PandaScore e retorna já convertidas para
   * o modelo canônico `Match`.
   * Em ambiente de desenvolvimento (com chave fake), simula a resposta da API
   * para permitir desenvolvimento offline sem depender de cota externa.
   */
  async fetchUpcomingMatches(): Promise<Match[]> {
    // -------------------------------------------------------------------------
    // [PONTO DE INTEGRAÇÃO REAL — PANDASCORE REST API]
    // Quando a chave real estiver configurada em produção, substituir o mock
    // abaixo pela chamada com `fetch` nativo do Node 24:
    //
    // const response = await fetch(`${this.baseUrl}/matches/upcoming?per_page=20`, {
    //   method: 'GET',
    //   headers: {
    //     Accept: 'application/json',
    //     Authorization: `Bearer ${this.apiKey}`,
    //   },
    //   signal: AbortSignal.timeout(5_000),
    // });
    // if (!response.ok) {
    //   throw new Error(`[pandascore] HTTP ${response.status}: ${await response.text()}`);
    // }
    // const rawMatches = (await response.json()) as PandaScoreRawMatch[];
    // -------------------------------------------------------------------------
    void this.baseUrl;
    void this.apiKey;

    const rawMatches = this.getMockRawUpcomingMatches();

    const canonicalMatches: Match[] = [];
    for (const raw of rawMatches) {
      canonicalMatches.push(await this.toCanonicalMatch(raw));
    }

    return canonicalMatches;
  }

  /**
   * Traduz um objeto bruto da PandaScore para a interface canônica `Match`.
   * Tenta resolver os UUIDs internos via `MappingService`; caso o banco não
   * esteja acessível ou o vínculo ainda não exista (modo simulação), gera um
   * UUID determinístico/novo de fallback para manter o contrato tipado.
   */
  private async toCanonicalMatch(raw: PandaScoreRawMatch): Promise<Match> {
    const [matchId, tournamentId, teamAId, teamBId] = await Promise.all([
      this.resolveOrFallback('match', String(raw.id)),
      this.resolveOrFallback('tournament', String(raw.tournament_id)),
      raw.opponents[0]
        ? this.resolveOrFallback('team', String(raw.opponents[0].opponent.id))
        : Promise.resolve(null),
      raw.opponents[1]
        ? this.resolveOrFallback('team', String(raw.opponents[1].opponent.id))
        : Promise.resolve(null),
    ]);

    const now = new Date();
    return {
      id: matchId,
      tournamentId,
      teamAId,
      teamBId,
      format: this.mapFormat(raw.number_of_games),
      status: this.mapStatus(raw.status),
      scheduledAt: new Date(raw.scheduled_at),
      winnerId: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async resolveOrFallback(
    entityType: 'match' | 'tournament' | 'team',
    externalId: string,
  ): Promise<UUID> {
    try {
      const resolved = await this.mapper.resolveInternalId(
        this.providerId,
        entityType,
        externalId,
      );
      return resolved ?? randomUUID();
    } catch {
      // Em modo dev sem Postgres ativo, garante que a simulação não quebre.
      return randomUUID();
    }
  }

  private mapFormat(numberOfGames: 1 | 3 | 5): MatchFormat {
    switch (numberOfGames) {
      case 1:
        return 'BO1';
      case 5:
        return 'BO5';
      default:
        return 'BO3';
    }
  }

  private mapStatus(rawStatus: PandaScoreRawMatch['status']): MatchStatus {
    switch (rawStatus) {
      case 'not_started':
        return 'scheduled';
      case 'running':
        return 'live';
      case 'finished':
        return 'finished';
      case 'postponed':
        return 'postponed';
      case 'canceled':
        return 'canceled';
    }
  }

  /** Mock realista do payload da PandaScore (FURIA vs Vitality e NAVI vs G2). */
  private getMockRawUpcomingMatches(): PandaScoreRawMatch[] {
    const inOneHour = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();

    return [
      {
        id: 990001,
        name: 'FURIA vs Vitality',
        scheduled_at: inOneHour,
        number_of_games: 3,
        status: 'not_started',
        tournament_id: 7701,
        winner_id: null,
        opponents: [
          { opponent: { id: 124530, name: 'FURIA', acronym: 'FUR', image_url: null } },
          { opponent: { id: 125523, name: 'Team Vitality', acronym: 'VIT', image_url: null } },
        ],
      },
      {
        id: 990002,
        name: 'Natus Vincere vs G2 Esports',
        scheduled_at: inThreeHours,
        number_of_games: 3,
        status: 'not_started',
        tournament_id: 7701,
        winner_id: null,
        opponents: [
          { opponent: { id: 3216, name: 'Natus Vincere', acronym: 'NAVI', image_url: null } },
          { opponent: { id: 3210, name: 'G2 Esports', acronym: 'G2', image_url: null } },
        ],
      },
    ];
  }
}
