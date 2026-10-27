// =============================================================================
// src/providers/pandascore/pandascore.adapter.ts — Adapter REST da PandaScore
// -----------------------------------------------------------------------------
// O QUE: Encapsula chamadas HTTP REST para a API da PandaScore (calendário,
//        partidas futuras, torneios e times), converte o payload externo para
//        o Modelo Canônico (`Match`) e sincroniza (UPSERT) com o PostgreSQL.
// POR QUE: A PandaScore tem um formato próprio (`number_of_games: 3`,
//          `status: "not_started"`, `opponents: [...]`). O Adapter atua como
//          camada anticorrupção: traduz tudo na borda do sistema para que o
//          restante do BFF trabalhe apenas com `Match` (UUIDs, `'BO3'`,
//          `'scheduled'`), sem conhecer detalhes da PandaScore.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
// [UPDATE]: Importa o pool `db` para persistir torneios, times e partidas no Postgres
// durante a sincronização (`syncMatches`).
import { db } from '../../core/database.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type {
  Match,
  MatchFormat,
  MatchStatus,
  TournamentTier,
  UUID,
} from '../../core/models.js';

/** Formato bruto retornado pelo endpoint `/csgo/matches/upcoming` da PandaScore. */
interface PandaScoreRawMatch {
  id: number;
  name: string;
  scheduled_at: string;
  number_of_games: 1 | 3 | 5;
  status: 'not_started' | 'running' | 'finished' | 'postponed' | 'canceled';
  tournament: {
    id: number;
    name: string;
    tier: TournamentTier;
    prizepool: number;
  };
  winner_id: number | null;
  opponents: Array<{
    opponent: {
      id: number;
      name: string;
      acronym: string | null;
      image_url: string | null;
    };
  }>;
  // [UPDATE]: UUID canônico fixo opcional para alinhar a partida ao vivo de dev
  // com o stream simulado da Cito (`00000000-0000-4000-8000-000000000001`).
  preferredCanonicalId?: UUID;
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
   * [UPDATE]: Busca as partidas na PandaScore e persiste (UPSERT) torneios,
   * equipes, partidas, mapas e vínculos (`provider_mappings`) no PostgreSQL.
   * Respeita a ordem de chaves estrangeiras (`tournaments` -> `teams` -> `matches` -> `match_maps`).
   */
  async syncMatches(): Promise<Match[]> {
    const rawMatches = this.getMockRawUpcomingMatches();
    const syncedMatches: Match[] = [];

    for (const raw of rawMatches) {
      // 1. Resolve ou cria o UUID do Torneio e faz UPSERT em `tournaments`.
      const tournamentId = await this.resolveOrCreateEntityId(
        'tournament',
        String(raw.tournament.id),
      );
      await db.query(
        `INSERT INTO tournaments (id, name, tier, prize_pool)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               tier = EXCLUDED.tier,
               prize_pool = EXCLUDED.prize_pool,
               updated_at = NOW()`,
        [tournamentId, raw.tournament.name, raw.tournament.tier, raw.tournament.prizepool],
      );
      await this.mapper.linkProviderId({
        provider: this.providerId,
        entityType: 'tournament',
        externalId: String(raw.tournament.id),
        entityId: tournamentId,
      });

      // 2. Resolve ou cria os UUIDs dos Times A e B e faz UPSERT em `teams`.
      const rawTeamA = raw.opponents[0]?.opponent ?? null;
      const rawTeamB = raw.opponents[1]?.opponent ?? null;

      let teamAId: UUID | null = null;
      if (rawTeamA) {
        teamAId = await this.resolveOrCreateEntityId('team', String(rawTeamA.id));
        await db.query(
          `INSERT INTO teams (id, name, acronym, logo_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 acronym = EXCLUDED.acronym,
                 logo_url = EXCLUDED.logo_url,
                 updated_at = NOW()`,
          [teamAId, rawTeamA.name, rawTeamA.acronym, rawTeamA.image_url],
        );
        await this.mapper.linkProviderId({
          provider: this.providerId,
          entityType: 'team',
          externalId: String(rawTeamA.id),
          entityId: teamAId,
        });
      }

      let teamBId: UUID | null = null;
      if (rawTeamB) {
        teamBId = await this.resolveOrCreateEntityId('team', String(rawTeamB.id));
        await db.query(
          `INSERT INTO teams (id, name, acronym, logo_url)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 acronym = EXCLUDED.acronym,
                 logo_url = EXCLUDED.logo_url,
                 updated_at = NOW()`,
          [teamBId, rawTeamB.name, rawTeamB.acronym, rawTeamB.image_url],
        );
        await this.mapper.linkProviderId({
          provider: this.providerId,
          entityType: 'team',
          externalId: String(rawTeamB.id),
          entityId: teamBId,
        });
      }

      // 3. Resolve ou cria o UUID da Partida e faz UPSERT em `matches`.
      const matchId = await this.resolveOrCreateEntityId(
        'match',
        String(raw.id),
        raw.preferredCanonicalId,
      );
      const format = this.mapFormat(raw.number_of_games);
      const status = this.mapStatus(raw.status);
      const scheduledAt = new Date(raw.scheduled_at);

      await db.query(
        `INSERT INTO matches (id, tournament_id, team_a_id, team_b_id, format, status, scheduled_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE
           SET tournament_id = EXCLUDED.tournament_id,
               team_a_id = EXCLUDED.team_a_id,
               team_b_id = EXCLUDED.team_b_id,
               format = EXCLUDED.format,
               status = EXCLUDED.status,
               scheduled_at = EXCLUDED.scheduled_at,
               updated_at = NOW()`,
        [matchId, tournamentId, teamAId, teamBId, format, status, scheduledAt],
      );
      await this.mapper.linkProviderId({
        provider: this.providerId,
        entityType: 'match',
        externalId: String(raw.id),
        entityId: matchId,
      });

      // 4. Popula os mapas da série (`match_maps`) para enriquecer `GET /api/matches/:id`.
      const defaultMaps = [
        { number: 1, name: 'de_mirage', pick: teamAId, status: status === 'live' ? 'live' : 'upcoming' },
        { number: 2, name: 'de_inferno', pick: teamBId, status: 'upcoming' },
        { number: 3, name: 'de_nuke', pick: null, status: 'upcoming' },
      ] as const;

      for (const mapItem of defaultMaps) {
        await db.query(
          `INSERT INTO match_maps (match_id, map_number, map_name, pick_team_id, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (match_id, map_number) DO UPDATE
             SET map_name = EXCLUDED.map_name,
                 pick_team_id = EXCLUDED.pick_team_id,
                 status = EXCLUDED.status,
                 updated_at = NOW()`,
          [matchId, mapItem.number, mapItem.name, mapItem.pick, mapItem.status],
        );
      }

      const now = new Date();
      syncedMatches.push({
        id: matchId,
        tournamentId,
        teamAId,
        teamBId,
        format,
        status,
        scheduledAt,
        winnerId: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    return syncedMatches;
  }

  /**
   * Traduz um objeto bruto da PandaScore para a interface canônica `Match`.
   */
  private async toCanonicalMatch(raw: PandaScoreRawMatch): Promise<Match> {
    const [matchId, tournamentId, teamAId, teamBId] = await Promise.all([
      this.resolveOrCreateEntityId('match', String(raw.id), raw.preferredCanonicalId),
      this.resolveOrCreateEntityId('tournament', String(raw.tournament.id)),
      raw.opponents[0]
        ? this.resolveOrCreateEntityId('team', String(raw.opponents[0].opponent.id))
        : Promise.resolve(null),
      raw.opponents[1]
        ? this.resolveOrCreateEntityId('team', String(raw.opponents[1].opponent.id))
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

  private async resolveOrCreateEntityId(
    entityType: 'match' | 'tournament' | 'team',
    externalId: string,
    preferredUuid?: UUID,
  ): Promise<UUID> {
    try {
      const resolved = await this.mapper.resolveInternalId(
        this.providerId,
        entityType,
        externalId,
      );
      return resolved ?? preferredUuid ?? randomUUID();
    } catch {
      return preferredUuid ?? randomUUID();
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

  /**
   * Mock realista de CS2 contendo 1 partida AO VIVO (`FURIA vs Team Vitality`,
   * vinculada ao UUID `00000000-0000-4000-8000-000000000001` que recebe eventos
   * em tempo real da Cito) e 2 partidas agendadas para exibição imediata no app.
   */
  private getMockRawUpcomingMatches(): PandaScoreRawMatch[] {
    const nowIso = new Date().toISOString();
    const inOneHour = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const inThreeHours = new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();

    return [
      {
        id: 990001,
        preferredCanonicalId: '00000000-0000-4000-8000-000000000001',
        name: 'FURIA vs Vitality',
        scheduled_at: nowIso,
        number_of_games: 3,
        status: 'running',
        tournament: {
          id: 7701,
          name: 'IEM Katowice 2026',
          tier: 'S',
          prizepool: 1_000_000,
        },
        winner_id: null,
        opponents: [
          { opponent: { id: 124530, name: 'FURIA', acronym: 'FUR', image_url: null } },
          { opponent: { id: 125523, name: 'Team Vitality', acronym: 'VIT', image_url: null } },
        ],
      },
      {
        id: 990002,
        name: 'Natus Vincere vs G2 Esports',
        scheduled_at: inOneHour,
        number_of_games: 3,
        status: 'not_started',
        tournament: {
          id: 7701,
          name: 'IEM Katowice 2026',
          tier: 'S',
          prizepool: 1_000_000,
        },
        winner_id: null,
        opponents: [
          { opponent: { id: 3216, name: 'Natus Vincere', acronym: 'NAVI', image_url: null } },
          { opponent: { id: 3210, name: 'G2 Esports', acronym: 'G2', image_url: null } },
        ],
      },
      {
        id: 990003,
        name: 'Team Spirit vs MOUZ',
        scheduled_at: inThreeHours,
        number_of_games: 3,
        status: 'not_started',
        tournament: {
          id: 7702,
          name: 'BLAST Premier Spring Final',
          tier: 'S',
          prizepool: 425_000,
        },
        winner_id: null,
        opponents: [
          { opponent: { id: 126944, name: 'Team Spirit', acronym: 'TS', image_url: null } },
          { opponent: { id: 3240, name: 'MOUZ', acronym: 'MOUZ', image_url: null } },
        ],
      },
    ];
  }
}
