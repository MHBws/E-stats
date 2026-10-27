// =============================================================================
// src/providers/pandascore/pandascore.adapter.ts — Adapter REST Real da PandaScore
// -----------------------------------------------------------------------------
// O QUE: Realiza chamadas HTTP REST reais para a API da PandaScore
//        (`https://api.pandascore.co/csgo/matches`), valida a presença de
//        `env.PANDASCORE_API_KEY`, converte o payload real para o Modelo
//        Canônico (`Match`) e persiste (UPSERT) torneios, equipes, partidas,
//        mapas e vínculos no PostgreSQL.
// POR QUE: Substitui os mocks estáticos pelo calendário oficial e atualizado de
//          CS2 da PandaScore, tratando as particularidades do JSON real da API
//          (como `tier` em minúsculas `'s'..'d' | 'unranked'`, `prizepool` em
//          texto livre `"10000 United States Dollar"` e oponentes ainda `"TBD"`).
// =============================================================================
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { db } from '../../core/database.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type {
  MapStatus,
  Match,
  MatchFormat,
  MatchStatus,
  TournamentTier,
  UUID,
} from '../../core/models.js';

/** Formato real retornado pelo endpoint `/csgo/matches` da PandaScore API. */
export interface PandaScoreRawMatch {
  id: number;
  name: string;
  scheduled_at: string | null;
  begin_at: string | null;
  number_of_games: number | null;
  status: 'not_started' | 'running' | 'finished' | 'postponed' | 'canceled';
  tournament_id: number;
  winner_id: number | null;
  league?: {
    id: number;
    name: string;
  } | null;
  serie?: {
    id: number;
    full_name: string | null;
    name: string | null;
  } | null;
  tournament: {
    id: number;
    name: string;
    tier: string | null;
    prizepool: string | null;
    begin_at: string | null;
    end_at: string | null;
  };
  opponents: Array<{
    type?: string;
    opponent: {
      id: number;
      name: string;
      acronym: string | null;
      image_url: string | null;
    };
  }>;
  games?: Array<{
    id: number;
    position: number;
    status: 'not_started' | 'running' | 'finished' | 'not_played';
    winner?: {
      id: number | null;
    } | null;
  }>;
}

/** IDs externos dos mocks antigos para limpeza automática no banco. */
const LEGACY_MOCK_EXTERNAL_MATCH_IDS = ['990001', '990002', '990003'];
const LEGACY_MOCK_MATCH_UUID = '00000000-0000-4000-8000-000000000001';

export class PandaScoreAdapter {
  readonly providerId = 'pandascore' as const;
  private readonly baseUrl = 'https://api.pandascore.co/csgo';

  constructor(
    private readonly mapper: MappingService = mappingService,
    private readonly apiKey: string = env.PANDASCORE_API_KEY || env.providers.pandaScoreApiKey,
  ) {}

  /**
   * [UPDATE]: Valida que a chave real da PandaScore está configurada no ambiente.
   * Lança erro explícito no log caso esteja vazia, indefinida ou ainda com o placeholder fake.
   */
  private assertValidApiKey(): string {
    const key = this.apiKey?.trim();
    if (!key || key.startsWith('fake_')) {
      const errorMsg =
        '[pandascore] ERRO CRÍTICO: Variável de ambiente PANDASCORE_API_KEY está vazia, indefinida ou utilizando chave fake. Configure uma chave real no arquivo .env.';
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    return key;
  }

  /**
   * [UPDATE]: Faz a requisição HTTP real para a API da PandaScore buscando
   * partidas ao vivo (`running`) e futuras (`not_started`) de CS2.
   */
  private async fetchRawMatchesFromApi(): Promise<PandaScoreRawMatch[]> {
    const token = this.assertValidApiKey();

    // Busca partidas em andamento (`running`) e próximas (`not_started`) ordenadas por horário.
    const url = `${this.baseUrl}/matches?filter[status]=running,not_started&sort=status,begin_at&per_page=25`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const errMsg = `[pandascore] Falha na requisição HTTP ${response.status} (${response.statusText}): ${body}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('[pandascore] Resposta inesperada da API PandaScore (esperado array JSON).');
    }

    return data as PandaScoreRawMatch[];
  }

  /**
   * Busca partidas reais de CS2 na PandaScore e retorna convertidas para o
   * modelo canônico `Match`.
   */
  async fetchUpcomingMatches(): Promise<Match[]> {
    const rawMatches = await this.fetchRawMatchesFromApi();

    const canonicalMatches: Match[] = [];
    for (const raw of rawMatches) {
      canonicalMatches.push(await this.toCanonicalMatch(raw));
    }

    return canonicalMatches;
  }

  /**
   * [UPDATE]: Busca o calendário REAL na API da PandaScore, remove eventuais
   * dados mockados antigos do banco e faz UPSERT de torneios, equipes, partidas,
   * mapas e mapeamentos no PostgreSQL.
   */
  async syncMatches(): Promise<Match[]> {
    const rawMatches = await this.fetchRawMatchesFromApi();

    // Remove os 3 registros de mock antigos (se existirem) para que a Home Screen
    // exiba exclusivamente o calendário real vindo da PandaScore.
    await this.purgeLegacyMockData();

    const syncedMatches: Match[] = [];

    for (const raw of rawMatches) {
      // 1. Torneio: normaliza nome (Liga + Série/Stage), tier ('S'..'D') e prize_pool numérico.
      const tournamentId = await this.resolveOrCreateEntityId(
        'tournament',
        String(raw.tournament.id),
      );
      const tournamentName = this.formatTournamentName(raw);
      const tournamentTier = this.normalizeTier(raw.tournament.tier);
      const prizePool = this.parsePrizePool(raw.tournament.prizepool);
      const startDate = raw.tournament.begin_at ? new Date(raw.tournament.begin_at) : null;
      const endDate = raw.tournament.end_at ? new Date(raw.tournament.end_at) : null;

      await db.query(
        `INSERT INTO tournaments (id, name, tier, start_date, end_date, prize_pool)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               tier = EXCLUDED.tier,
               start_date = EXCLUDED.start_date,
               end_date = EXCLUDED.end_date,
               prize_pool = EXCLUDED.prize_pool,
               updated_at = NOW()`,
        [
          tournamentId,
          tournamentName,
          tournamentTier,
          startDate,
          endDate && startDate && endDate < startDate ? startDate : endDate,
          prizePool,
        ],
      );
      await this.mapper.linkProviderId({
        provider: this.providerId,
        entityType: 'tournament',
        externalId: String(raw.tournament.id),
        entityId: tournamentId,
      });

      // 2. Equipes (Time A e Time B): podem estar ausentes se a partida ainda for "TBD".
      const rawTeamA = raw.opponents?.[0]?.opponent ?? null;
      const rawTeamB = raw.opponents?.[1]?.opponent ?? null;

      let teamAId: UUID | null = null;
      if (rawTeamA) {
        teamAId = await this.upsertTeam(rawTeamA);
      }

      let teamBId: UUID | null = null;
      if (rawTeamB && (!rawTeamA || rawTeamB.id !== rawTeamA.id)) {
        teamBId = await this.upsertTeam(rawTeamB);
      }

      // 3. Partida: resolve UUID canônico e faz UPSERT em `matches`.
      const matchId = await this.resolveOrCreateEntityId('match', String(raw.id));
      const format = this.mapFormat(raw.number_of_games);
      const status = this.mapStatus(raw.status);
      const scheduledIso = raw.scheduled_at ?? raw.begin_at ?? new Date().toISOString();
      const scheduledAt = new Date(scheduledIso);

      let winnerId: UUID | null = null;
      if (raw.winner_id !== null && raw.winner_id !== undefined) {
        if (rawTeamA && raw.winner_id === rawTeamA.id) {
          winnerId = teamAId;
        } else if (rawTeamB && raw.winner_id === rawTeamB.id) {
          winnerId = teamBId;
        }
      }

      await db.query(
        `INSERT INTO matches (id, tournament_id, team_a_id, team_b_id, format, status, scheduled_at, winner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE
           SET tournament_id = EXCLUDED.tournament_id,
               team_a_id = EXCLUDED.team_a_id,
               team_b_id = EXCLUDED.team_b_id,
               format = EXCLUDED.format,
               status = EXCLUDED.status,
               scheduled_at = EXCLUDED.scheduled_at,
               winner_id = EXCLUDED.winner_id,
               updated_at = NOW()`,
        [matchId, tournamentId, teamAId, teamBId, format, status, scheduledAt, winnerId],
      );
      await this.mapper.linkProviderId({
        provider: this.providerId,
        entityType: 'match',
        externalId: String(raw.id),
        entityId: matchId,
      });

      // 4. Mapas da série (`games` do payload da PandaScore -> `match_maps`).
      if (Array.isArray(raw.games)) {
        for (const game of raw.games) {
          if (game.position < 1 || game.position > 5) continue;
          const mapStatus = this.mapGameStatus(game.status);
          await db.query(
            `INSERT INTO match_maps (match_id, map_number, map_name, pick_team_id, status)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (match_id, map_number) DO UPDATE
               SET status = EXCLUDED.status,
                   updated_at = NOW()`,
            [matchId, game.position, `Mapa ${game.position}`, null, mapStatus],
          );
        }
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
        winnerId,
        createdAt: now,
        updatedAt: now,
      });
    }

    return syncedMatches;
  }

  /** Insere ou atualiza uma equipe no PostgreSQL e vincula seu ID externo. */
  private async upsertTeam(rawTeam: {
    id: number;
    name: string;
    acronym: string | null;
    image_url: string | null;
  }): Promise<UUID> {
    const teamId = await this.resolveOrCreateEntityId('team', String(rawTeam.id));
    // Garante limite de VARCHAR(10) da coluna `acronym` no banco.
    const safeAcronym = rawTeam.acronym ? rawTeam.acronym.slice(0, 10) : null;

    await db.query(
      `INSERT INTO teams (id, name, acronym, logo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             acronym = EXCLUDED.acronym,
             logo_url = EXCLUDED.logo_url,
             updated_at = NOW()`,
      [teamId, rawTeam.name, safeAcronym, rawTeam.image_url],
    );

    await this.mapper.linkProviderId({
      provider: this.providerId,
      entityType: 'team',
      externalId: String(rawTeam.id),
      entityId: teamId,
    });

    return teamId;
  }

  /** Remove os 3 jogos mockados antigos caso tenham sido inseridos anteriormente. */
  private async purgeLegacyMockData(): Promise<void> {
    try {
      await db.query(
        `DELETE FROM matches
          WHERE id = $1
             OR id IN (
               SELECT entity_id
                 FROM provider_mappings
                WHERE provider = 'pandascore'
                  AND entity_type = 'match'
                  AND external_id = ANY($2::text[])
             )`,
        [LEGACY_MOCK_MATCH_UUID, LEGACY_MOCK_EXTERNAL_MATCH_IDS],
      );
      await db.query(
        `DELETE FROM provider_mappings
          WHERE provider = 'pandascore'
            AND entity_type = 'match'
            AND external_id = ANY($1::text[])`,
        [LEGACY_MOCK_EXTERNAL_MATCH_IDS],
      );
    } catch (err) {
      console.warn('[pandascore] Aviso ao limpar mocks antigos:', err);
    }
  }

  /** Traduz um objeto bruto da PandaScore para a interface canônica `Match`. */
  private async toCanonicalMatch(raw: PandaScoreRawMatch): Promise<Match> {
    const [matchId, tournamentId, teamAId, teamBId] = await Promise.all([
      this.resolveOrCreateEntityId('match', String(raw.id)),
      this.resolveOrCreateEntityId('tournament', String(raw.tournament.id)),
      raw.opponents?.[0]
        ? this.resolveOrCreateEntityId('team', String(raw.opponents[0].opponent.id))
        : Promise.resolve(null),
      raw.opponents?.[1]
        ? this.resolveOrCreateEntityId('team', String(raw.opponents[1].opponent.id))
        : Promise.resolve(null),
    ]);

    const now = new Date();
    const scheduledIso = raw.scheduled_at ?? raw.begin_at ?? now.toISOString();

    return {
      id: matchId,
      tournamentId,
      teamAId,
      teamBId,
      format: this.mapFormat(raw.number_of_games),
      status: this.mapStatus(raw.status),
      scheduledAt: new Date(scheduledIso),
      winnerId: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async resolveOrCreateEntityId(
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
      return randomUUID();
    }
  }

  /** Combina nome da Liga + Série/Torneio (ex.: "CCT Europe · Playoffs"). */
  private formatTournamentName(raw: PandaScoreRawMatch): string {
    const leagueName = raw.league?.name?.trim();
    const serieName = raw.serie?.full_name?.trim() || raw.serie?.name?.trim();
    const stageName = raw.tournament?.name?.trim();

    if (leagueName && stageName && !stageName.toLowerCase().includes(leagueName.toLowerCase())) {
      return serieName ? `${leagueName} ${serieName} - ${stageName}` : `${leagueName} - ${stageName}`;
    }
    return stageName || leagueName || 'CS2 Tournament';
  }

  /**
   * Converte o tier da PandaScore (`'s' | 'a' | 'b' | 'c' | 'd' | 'unranked' | null`)
   * para o CHECK constraint do Postgres (`'S' | 'A' | 'B' | 'C' | 'D' | null`).
   */
  private normalizeTier(rawTier: string | null | undefined): TournamentTier | null {
    if (!rawTier) return null;
    const upper = rawTier.trim().toUpperCase();
    if (upper === 'S' || upper === 'A' || upper === 'B' || upper === 'C' || upper === 'D') {
      return upper;
    }
    return null;
  }

  /**
   * Extrai valor numérico de strings como `"50000 United States Dollar"` ou `"$10,000"`.
   */
  private parsePrizePool(rawPrize: string | null | undefined): number | null {
    if (!rawPrize) return null;
    const digitsOnly = rawPrize.replace(/[^0-9.]/g, '');
    if (!digitsOnly) return null;
    const parsed = Number.parseFloat(digitsOnly);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  private mapFormat(numberOfGames: number | null | undefined): MatchFormat {
    if (numberOfGames === 1) return 'BO1';
    if (numberOfGames === 5) return 'BO5';
    return 'BO3';
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

  private mapGameStatus(
    rawStatus: 'not_started' | 'running' | 'finished' | 'not_played',
  ): MapStatus {
    switch (rawStatus) {
      case 'running':
        return 'live';
      case 'finished':
        return 'finished';
      default:
        return 'upcoming';
    }
  }
}
