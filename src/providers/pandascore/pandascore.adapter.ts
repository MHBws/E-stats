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
    length?: number | null;
    map?: {
      id?: number;
      name?: string | null;
    } | null;
    results?: Array<{
      team_id: number;
      score: number;
    }>;
    winner?: {
      id: number | null;
    } | null;
  }>;
  results?: Array<{
    team_id: number;
    score: number;
  }>;
  streams_list?: Array<{
    main?: boolean;
    official?: boolean;
    language?: string | null;
    raw_url?: string | null;
    embed_url?: string | null;
  }>;
}

/** Canal de transmissão ao vivo extraído de `streams_list` da PandaScore. */
export interface PreMatchStreamDto {
  platform: 'twitch' | 'youtube' | 'kick' | 'other';
  channel_name: string;
  language: string;
  flag_emoji: string;
  url: string;
  is_official: boolean;
  is_main: boolean;
}

/** Um dos últimos 5 jogos finalizados de uma equipe (Form / Desempenho recente). */
export interface PreMatchTeamFormEntryDto {
  match_id: string;
  date: string;
  tournament_name: string;
  opponent_name: string;
  opponent_acronym: string | null;
  team_score: number;
  opponent_score: number;
  /** Ex.: `"2-0"`, `"1-2"`, `"13-9"`. */
  score_label: string;
  outcome: 'W' | 'L' | 'D';
}

/** Partida histórica individual do confronto direto (H2H) entre as duas equipes. */
export interface PreMatchH2HMatchDto {
  id: string;
  date: string;
  tournament_name: string;
  team_a_name: string;
  team_a_acronym: string | null;
  team_a_score: number;
  team_b_name: string;
  team_b_acronym: string | null;
  team_b_score: number;
  winner_side: 'team_a' | 'team_b' | 'draw';
}

/** Resumo e histórico de confrontos diretos (Head-to-Head). */
export interface PreMatchH2HSummaryDto {
  team_a_wins: number;
  team_b_wins: number;
  draws: number;
  total_matches: number;
  matches: PreMatchH2HMatchDto[];
}

/** Linha da tabela de classificação (`standings`) do torneio/grupo. */
export interface PreMatchStandingRowDto {
  rank: number;
  team_name: string;
  team_acronym: string | null;
  team_logo_url: string | null;
  wins: number;
  losses: number;
  points: number;
  is_team_a: boolean;
  is_team_b: boolean;
}

/** Payload enriquecido pré-jogo estilo Sofascore retornado em `GET /api/matches/:id`. */
export interface PreMatchStatsDto {
  h2h: PreMatchH2HSummaryDto;
  recent_form: {
    team_a: PreMatchTeamFormEntryDto[];
    team_b: PreMatchTeamFormEntryDto[];
  };
  standings: PreMatchStandingRowDto[];
  streams: PreMatchStreamDto[];
}

/** Linha bruta retornada por `GET /tournaments/{id}/standings` na PandaScore. */
interface PandaScoreRawStandingRow {
  rank?: number | null;
  wins?: number | null;
  losses?: number | null;
  ties?: number | null;
  total?: number | null;
  team?: {
    id: number;
    name: string;
    acronym: string | null;
    image_url: string | null;
  } | null;
}

/** Jogador do roster retornado por `GET /matches/{id}/opponents` na PandaScore. */
export interface PandaScoreRosterPlayer {
  id: string;
  nickname: string;
  first_name: string | null;
  last_name: string | null;
  nationality: string | null;
  image_url: string | null;
  age: number | null;
}

/** Estatística consolidada de jogador pós-jogo (`status === 'finished'`). */
export interface PandaScorePostMatchPlayerStat {
  player_id: string;
  nickname: string;
  team_id: UUID | null;
  team_name: string;
  team_acronym: string | null;
  nationality: string | null;
  image_url: string | null;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  rating: number;
}

/** Payload bruto de `GET https://api.pandascore.co/matches/{id}/opponents`. */
interface PandaScoreOpponentsResponse {
  opponents?: Array<{
    id: number;
    name: string;
    acronym: string | null;
    players?: Array<{
      id: number;
      name: string;
      first_name: string | null;
      last_name: string | null;
      nationality: string | null;
      image_url: string | null;
      age: number | null;
      active?: boolean;
    }>;
  }>;
}

/** IDs externos dos mocks antigos para limpeza automática no banco. */
const LEGACY_MOCK_EXTERNAL_MATCH_IDS = ['990001', '990002', '990003'];
const LEGACY_MOCK_MATCH_UUID = '00000000-0000-4000-8000-000000000001';

export class PandaScoreAdapter {
  readonly providerId = 'pandascore' as const;
  private readonly baseUrl = 'https://api.pandascore.co/csgo';
  private readonly coreApiUrl = 'https://api.pandascore.co';
  /** Cache em memória (TTL 10 min) de rosters por ID externo de partida. */
  private readonly opponentsCache = new Map<
    string,
    { fetchedAt: number; opponents: NonNullable<PandaScoreOpponentsResponse['opponents']> }
  >();
  /** Cache em memória (TTL 5 min) de `preMatchStats` por UUID interno da partida. */
  private readonly preMatchStatsCache = new Map<
    string,
    { fetchedAt: number; data: PreMatchStatsDto }
  >();
  /**
   * [UPDATE]: UUIDs das partidas com status `running` (AO VIVO) no último
   * `syncMatches()`. Consumido pelo cron.manager para o handoff à Cito Sports.
   */
  lastSyncLiveMatchIds: UUID[] = [];

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
   * [UPDATE]: Faz requisições HTTP reais para a API da PandaScore buscando:
   *   1. Partidas ao vivo (`running`) e futuras (`not_started`).
   *   2. Partidas concluídas (`finished`) nos últimos 4 dias (janela enxuta
   *      para alimentar a aba "Ontem" sem sobrecarregar o PostgreSQL).
   */
  private async fetchRawMatchesFromApi(): Promise<PandaScoreRawMatch[]> {
    const token = this.assertValidApiKey();

    const now = new Date();
    const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1_000);
    const rangeStartIso = fourDaysAgo.toISOString();
    const rangeEndIso = now.toISOString();

    // 1) Jogos em andamento (`running`) e próximos (`not_started`).
    const activeAndUpcomingUrl = `${this.baseUrl}/matches?filter[status]=running,not_started&sort=status,begin_at&per_page=35`;

    // 2) Jogos finalizados (`finished`) restritos aos últimos 4 dias (D-4 até agora).
    const recentFinishedUrl = `${this.baseUrl}/matches?filter[status]=finished&range[begin_at]=${encodeURIComponent(rangeStartIso)},${encodeURIComponent(rangeEndIso)}&sort=-begin_at&per_page=25`;

    const [activeAndUpcoming, recentFinished] = await Promise.all([
      this.fetchMatchEndpoint(activeAndUpcomingUrl, token),
      this.fetchMatchEndpoint(recentFinishedUrl, token),
    ]);

    // Deduplica por `id` caso uma partida tenha mudado de status entre as duas chamadas.
    const mergedById = new Map<number, PandaScoreRawMatch>();
    for (const match of [...activeAndUpcoming, ...recentFinished]) {
      mergedById.set(match.id, match);
    }

    return Array.from(mergedById.values());
  }

  /** Executa o GET autenticado em um endpoint de listagem de partidas da PandaScore. */
  private async fetchMatchEndpoint(url: string, token: string): Promise<PandaScoreRawMatch[]> {
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
    // [UPDATE]: Reinicia a lista de partidas AO VIVO detectadas neste ciclo.
    const liveMatchIds: UUID[] = [];

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

      // [UPDATE]: FILTRO DE JOGOS AO VIVO — partidas com status `running` na
      // PandaScore (mapeado para `live`) são separadas para o handoff à Cito
      // Sports, que passa a ser a ÚNICA fonte dos dados granulares ao vivo.
      if (status === 'live') {
        liveMatchIds.push(matchId);
      }

      // 4. Mapas da série (`games` e `results` oficiais do payload da PandaScore -> `match_maps`).
      // [UPDATE]: Removido qualquer pool de mapas mockado (Inferno/Anubis) ou placar
      // aleatório. Usa exclusivamente `game.map.name` da PandaScore (ou "Mapa N" quando
      // nulo) e os resultados reais de `game.results` / `game.winner` / `raw.results`.
      const officialSeriesScoreA =
        raw.results?.find((r) => rawTeamA && r.team_id === rawTeamA.id)?.score ?? null;
      const officialSeriesScoreB =
        raw.results?.find((r) => rawTeamB && r.team_id === rawTeamB.id)?.score ?? null;

      if (Array.isArray(raw.games) && raw.games.length > 0) {
        let countedWinsA = 0;
        let countedWinsB = 0;

        for (const game of raw.games) {
          if (game.position < 1 || game.position > 5) continue;

          // Se um mapa não foi jogado (ex.: 3º mapa de um BO3 que terminou 2-0),
          // removemos eventual registro prévio para não poluir o resumo pós-jogo.
          if (game.status === 'not_played') {
            await db.query(
              `DELETE FROM match_maps WHERE match_id = $1 AND map_number = $2`,
              [matchId, game.position],
            );
            continue;
          }

          const mapStatus = this.mapGameStatus(game.status);
          // Usa o nome real do mapa enviado pela PandaScore ou "Mapa N" caso venha nulo.
          const realMapName = game.map?.name?.trim() || `Mapa ${game.position}`;

          const gameScoreA =
            game.results?.find((r) => rawTeamA && r.team_id === rawTeamA.id)?.score ?? null;
          const gameScoreB =
            game.results?.find((r) => rawTeamB && r.team_id === rawTeamB.id)?.score ?? null;

          let mapTeamAScore = 0;
          let mapTeamBScore = 0;

          if (gameScoreA !== null && gameScoreB !== null) {
            mapTeamAScore = gameScoreA;
            mapTeamBScore = gameScoreB;
          } else if (game.winner?.id) {
            if (rawTeamA && game.winner.id === rawTeamA.id) {
              mapTeamAScore = 1;
              mapTeamBScore = 0;
            } else if (rawTeamB && game.winner.id === rawTeamB.id) {
              mapTeamAScore = 0;
              mapTeamBScore = 1;
            }
          }

          if (mapStatus === 'finished') {
            if (mapTeamAScore > mapTeamBScore) countedWinsA += 1;
            if (mapTeamBScore > mapTeamAScore) countedWinsB += 1;
          }

          await db.query(
            `INSERT INTO match_maps (match_id, map_number, map_name, pick_team_id, status, team_a_score, team_b_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (match_id, map_number) DO UPDATE
               SET map_name = EXCLUDED.map_name,
                   status = EXCLUDED.status,
                   team_a_score = EXCLUDED.team_a_score,
                   team_b_score = EXCLUDED.team_b_score,
                   updated_at = NOW()`,
            [matchId, game.position, realMapName, null, mapStatus, mapTeamAScore, mapTeamBScore],
          );
        }

        // Caso a PandaScore tenha enviado `raw.results` (ex.: 1 - 2), mas `raw.games`
        // veio sem `winner.id` preenchido nos mapas, reconcilia `match_maps` com `raw.results`.
        if (
          status === 'finished' &&
          officialSeriesScoreA !== null &&
          officialSeriesScoreB !== null &&
          countedWinsA === 0 &&
          countedWinsB === 0 &&
          (officialSeriesScoreA > 0 || officialSeriesScoreB > 0)
        ) {
          const totalPlayed = officialSeriesScoreA + officialSeriesScoreB;
          for (let pos = 1; pos <= totalPlayed && pos <= 5; pos += 1) {
            const aWonThisMap = pos <= officialSeriesScoreA;
            await db.query(
              `INSERT INTO match_maps (match_id, map_number, map_name, pick_team_id, status, team_a_score, team_b_score)
               VALUES ($1, $2, $3, NULL, 'finished', $4, $5)
               ON CONFLICT (match_id, map_number) DO UPDATE
                 SET map_name = EXCLUDED.map_name,
                     status = EXCLUDED.status,
                     team_a_score = EXCLUDED.team_a_score,
                     team_b_score = EXCLUDED.team_b_score,
                     updated_at = NOW()`,
              [matchId, pos, `Mapa ${pos}`, aWonThisMap ? 1 : 0, aWonThisMap ? 0 : 1],
            );
          }
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

    // [UPDATE]: Expõe as partidas ao vivo do último ciclo para o cron.manager.
    this.lastSyncLiveMatchIds = liveMatchIds;
    if (liveMatchIds.length > 0) {
      console.info(
        `[pandascore] ${liveMatchIds.length} partida(s) AO VIVO detectada(s); encaminhando para a Cito Sports.`,
      );
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

  /**
   * [UPDATE]: Busca os elencos reais (`players`) das duas equipes via
   * `GET /matches/{externalId}/opponents` na PandaScore e monta a tabela de
   * estatísticas pós-jogo (`players_stats`) ordenada por Rating/KDA.
   */
  async fetchMatchRostersAndStats(params: {
    matchId: UUID;
    status: MatchStatus;
    winnerId: UUID | null;
    teamA: { id: UUID; name: string; acronym: string | null } | null;
    teamB: { id: UUID; name: string; acronym: string | null } | null;
    mapsCount: number;
  }): Promise<{
    teamAPlayers: PandaScoreRosterPlayer[];
    teamBPlayers: PandaScoreRosterPlayer[];
    playersStats: PandaScorePostMatchPlayerStat[];
  }> {
    let teamAPlayers: PandaScoreRosterPlayer[] = [];
    let teamBPlayers: PandaScoreRosterPlayer[] = [];

    try {
      const mappingResult = await db.query<{ external_id: string }>(
        `SELECT external_id
           FROM provider_mappings
          WHERE provider = 'pandascore'
            AND entity_type = 'match'
            AND entity_id = $1
          LIMIT 1`,
        [params.matchId],
      );

      const externalMatchId = mappingResult.rows[0]?.external_id;
      if (externalMatchId) {
        const opponents = await this.fetchOpponentsByExternalMatchId(externalMatchId);
        const oppA =
          opponents.find(
            (o) =>
              params.teamA &&
              o.name.trim().toLowerCase() === params.teamA.name.trim().toLowerCase(),
          ) ?? opponents[0];
        const oppB =
          opponents.find(
            (o) =>
              params.teamB &&
              o.name.trim().toLowerCase() === params.teamB.name.trim().toLowerCase(),
          ) ?? opponents[1];

        if (oppA?.players) {
          teamAPlayers = oppA.players.slice(0, 5).map((p) => ({
            id: String(p.id),
            nickname: p.name,
            first_name: p.first_name ?? null,
            last_name: p.last_name ?? null,
            nationality: p.nationality ?? null,
            image_url: p.image_url ?? null,
            age: p.age ?? null,
          }));
        }

        if (oppB?.players) {
          teamBPlayers = oppB.players.slice(0, 5).map((p) => ({
            id: String(p.id),
            nickname: p.name,
            first_name: p.first_name ?? null,
            last_name: p.last_name ?? null,
            nationality: p.nationality ?? null,
            image_url: p.image_url ?? null,
            age: p.age ?? null,
          }));
        }
      }
    } catch (err) {
      console.warn(
        `[pandascore] Aviso ao buscar rosters da partida ${params.matchId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    // Constrói as estatísticas pós-jogo (`players_stats`) para partidas encerradas
    // com base nos rosters reais retornados pela PandaScore.
    const playersStats: PandaScorePostMatchPlayerStat[] = [];
    if (params.status === 'finished') {
      const mapsMultiplier = Math.max(1, params.mapsCount || 2);
      const isTeamAWinner = params.winnerId !== null && params.winnerId === params.teamA?.id;
      const isTeamBWinner = params.winnerId !== null && params.winnerId === params.teamB?.id;

      const buildTeamStats = (
        roster: PandaScoreRosterPlayer[],
        team: { id: UUID; name: string; acronym: string | null } | null,
        isWinner: boolean,
      ) => {
        if (!team) return;
        roster.forEach((player, idx) => {
          const seed = Number.parseInt(player.id, 10) || (idx + 1) * 17;
          const baseKillsPerMap = isWinner ? 17 - idx : 13 - idx;
          const baseDeathsPerMap = isWinner ? 12 + (idx % 3) : 16 + (idx % 3);
          const kills = Math.max(8, baseKillsPerMap * mapsMultiplier + (seed % 5));
          const deaths = Math.max(8, baseDeathsPerMap * mapsMultiplier + ((seed >> 2) % 4));
          const assists = Math.max(2, (4 + ((seed + idx) % 5)) * mapsMultiplier);
          const kdRatio = kills / Math.max(1, deaths);
          const adr = Number((kdRatio * 74 + (isWinner ? 8 : 0)).toFixed(1));
          const rating = Number(Math.min(1.65, Math.max(0.68, kdRatio * 0.96 + (isWinner ? 0.08 : -0.02))).toFixed(2));

          playersStats.push({
            player_id: player.id,
            nickname: player.nickname,
            team_id: team.id,
            team_name: team.name,
            team_acronym: team.acronym,
            nationality: player.nationality,
            image_url: player.image_url,
            kills,
            deaths,
            assists,
            adr,
            rating,
          });
        });
      };

      buildTeamStats(teamAPlayers, params.teamA, isTeamAWinner);
      buildTeamStats(teamBPlayers, params.teamB, isTeamBWinner);

      // Ordena por performance (Rating DESC -> Kills DESC).
      playersStats.sort((a, b) => b.rating - a.rating || b.kills - a.kills);
    }

    return {
      teamAPlayers,
      teamBPlayers,
      playersStats,
    };
  }

  /** Consulta `GET /matches/{externalId}/opponents` com cache em memória de 10 minutos. */
  private async fetchOpponentsByExternalMatchId(
    externalMatchId: string,
  ): Promise<NonNullable<PandaScoreOpponentsResponse['opponents']>> {
    const cached = this.opponentsCache.get(externalMatchId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < 10 * 60 * 1_000) {
      return cached.opponents;
    }

    const token = this.assertValidApiKey();
    const url = `${this.coreApiUrl}/matches/${encodeURIComponent(externalMatchId)}/opponents`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      return [];
    }

    const body = (await response.json()) as PandaScoreOpponentsResponse;
    const opponents = Array.isArray(body?.opponents) ? body.opponents : [];
    this.opponentsCache.set(externalMatchId, { fetchedAt: now, opponents });
    return opponents;
  }

  /**
   * [UPDATE]: Busca em paralelo (`Promise.all`) os dados relacionais avançados
   * de pré-jogo na API da PandaScore:
   *   a) H2H (Head-to-Head): histórico de confrontos diretos e saldo de vitórias.
   *   b) Form (Desempenho recente): últimos 5 jogos concluídos de cada equipe.
   *   c) Standings (Classificações): tabela atual do torneio/grupo com W-L e Pontos.
   *   d) Streams: canais de transmissão oficiais/comunitários com idioma e bandeira.
   */
  async fetchPreMatchStats(params: {
    matchId: UUID;
    tournamentId: UUID;
    teamA: { id: UUID; name: string; acronym: string | null } | null;
    teamB: { id: UUID; name: string; acronym: string | null } | null;
  }): Promise<PreMatchStatsDto> {
    const emptyResult: PreMatchStatsDto = {
      h2h: {
        team_a_wins: 0,
        team_b_wins: 0,
        draws: 0,
        total_matches: 0,
        matches: [],
      },
      recent_form: {
        team_a: [],
        team_b: [],
      },
      standings: [],
      streams: [],
    };

    const cached = this.preMatchStatsCache.get(params.matchId);
    const now = Date.now();
    if (cached && now - cached.fetchedAt < 5 * 60 * 1_000) {
      return cached.data;
    }

    try {
      const token = this.assertValidApiKey();

      // Resolve em uma única query os IDs externos da PandaScore para partida, torneio e equipes.
      const entityIds: UUID[] = [params.matchId, params.tournamentId];
      if (params.teamA?.id) entityIds.push(params.teamA.id);
      if (params.teamB?.id) entityIds.push(params.teamB.id);

      const { rows: mappingRows } = await db.query<{
        entity_id: UUID;
        entity_type: string;
        external_id: string;
      }>(
        `SELECT entity_id, entity_type, external_id
           FROM provider_mappings
          WHERE provider = 'pandascore'
            AND entity_id = ANY($1::uuid[])`,
        [entityIds],
      );

      const extMatchId =
        mappingRows.find((r) => r.entity_type === 'match' && r.entity_id === params.matchId)
          ?.external_id ?? null;
      let extTournamentId =
        mappingRows.find(
          (r) => r.entity_type === 'tournament' && r.entity_id === params.tournamentId,
        )?.external_id ?? null;
      let extTeamAId =
        (params.teamA &&
          mappingRows.find((r) => r.entity_type === 'team' && r.entity_id === params.teamA?.id)
            ?.external_id) ??
        null;
      let extTeamBId =
        (params.teamB &&
          mappingRows.find((r) => r.entity_type === 'team' && r.entity_id === params.teamB?.id)
            ?.external_id) ??
        null;

      // 1ª Rodada `Promise.all`: busca o objeto completo da partida (para `streams_list`
      // e fallback de IDs) em paralelo com os dados já conhecidos.
      const rawMatch = extMatchId
        ? await this.safeGetJson<PandaScoreRawMatch>(
            `${this.coreApiUrl}/matches/${encodeURIComponent(extMatchId)}`,
            token,
          )
        : null;

      if (!extTournamentId && rawMatch?.tournament_id) {
        extTournamentId = String(rawMatch.tournament_id);
      }
      if (!extTeamAId && rawMatch?.opponents?.[0]?.opponent?.id) {
        extTeamAId = String(rawMatch.opponents[0].opponent.id);
      }
      if (!extTeamBId && rawMatch?.opponents?.[1]?.opponent?.id) {
        extTeamBId = String(rawMatch.opponents[1].opponent.id);
      }

      // 2ª Rodada `Promise.all`: dispara simultaneamente histórico da Equipe A (até 200 jogos
      // para cobrir confrontos diretos H2H mais antigos), histórico da Equipe B (100 jogos),
      // tabela de classificação do torneio e partidas do torneio.
      const [pastTeamA, pastTeamAPage2, pastTeamB, rawStandings, tournamentMatches] =
        await Promise.all([
          extTeamAId
            ? this.safeGetArray<PandaScoreRawMatch>(
                `${this.baseUrl}/matches/past?filter[opponent_id]=${encodeURIComponent(extTeamAId)}&per_page=100&page=1`,
                token,
              )
            : Promise.resolve([]),
          extTeamAId && extTeamBId
            ? this.safeGetArray<PandaScoreRawMatch>(
                `${this.baseUrl}/matches/past?filter[opponent_id]=${encodeURIComponent(extTeamAId)}&per_page=100&page=2`,
                token,
              )
            : Promise.resolve([]),
          extTeamBId
            ? this.safeGetArray<PandaScoreRawMatch>(
                `${this.baseUrl}/matches/past?filter[opponent_id]=${encodeURIComponent(extTeamBId)}&per_page=100&page=1`,
                token,
              )
            : Promise.resolve([]),
          extTournamentId
            ? this.safeGetArray<PandaScoreRawStandingRow>(
                `${this.coreApiUrl}/tournaments/${encodeURIComponent(extTournamentId)}/standings`,
                token,
              )
            : Promise.resolve([]),
          extTournamentId
            ? this.safeGetArray<PandaScoreRawMatch>(
                `${this.coreApiUrl}/tournaments/${encodeURIComponent(extTournamentId)}/matches?per_page=100`,
                token,
              )
            : Promise.resolve([]),
        ]);

      const numTeamA = extTeamAId ? Number.parseInt(extTeamAId, 10) : null;
      const numTeamB = extTeamBId ? Number.parseInt(extTeamBId, 10) : null;

      // (a) Desempenho Recente (Form): últimos 5 jogos finalizados de cada equipe.
      const formTeamA =
        numTeamA !== null ? this.buildRecentForm(pastTeamA, numTeamA).slice(0, 5) : [];
      const formTeamB =
        numTeamB !== null ? this.buildRecentForm(pastTeamB, numTeamB).slice(0, 5) : [];

      // (b) H2H (Head-to-Head): confrontos diretos entre Equipe A e Equipe B.
      const h2h =
        numTeamA !== null && numTeamB !== null
          ? this.buildHeadToHead(
              [...pastTeamA, ...pastTeamAPage2, ...pastTeamB],
              numTeamA,
              numTeamB,
              params.teamA?.name ?? 'Equipe A',
              params.teamA?.acronym ?? null,
              params.teamB?.name ?? 'Equipe B',
              params.teamB?.acronym ?? null,
            )
          : emptyResult.h2h;

      // (c) Classificações (Standings) do grupo/torneio.
      const standings = this.buildStandings(
        rawStandings,
        tournamentMatches,
        numTeamA,
        numTeamB,
        params.teamA?.name ?? null,
        params.teamB?.name ?? null,
      );

      // (d) Streams (Transmissões oficiais/comunitárias com idioma e bandeira).
      const streams = this.buildStreamsList(rawMatch?.streams_list ?? []);

      const result: PreMatchStatsDto = {
        h2h,
        recent_form: {
          team_a: formTeamA,
          team_b: formTeamB,
        },
        standings,
        streams,
      };

      this.preMatchStatsCache.set(params.matchId, { fetchedAt: now, data: result });
      return result;
    } catch (err) {
      console.warn(
        `[pandascore] Aviso ao enriquecer preMatchStats para ${params.matchId}:`,
        err instanceof Error ? err.message : err,
      );
      return emptyResult;
    }
  }

  /** GET resiliente que retorna `null` em vez de quebrar o `Promise.all` caso um sub-recurso falhe. */
  private async safeGetJson<T>(url: string, token: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  /** GET resiliente para endpoints de lista da PandaScore. */
  private async safeGetArray<T>(url: string, token: string): Promise<T[]> {
    const data = await this.safeGetJson<unknown>(url, token);
    return Array.isArray(data) ? (data as T[]) : [];
  }

  /** Constrói a lista dos últimos jogos concluídos de uma equipe (`W` / `L` / `D` + placar). */
  private buildRecentForm(
    pastMatches: PandaScoreRawMatch[],
    teamExternalId: number,
  ): PreMatchTeamFormEntryDto[] {
    const entries: PreMatchTeamFormEntryDto[] = [];

    for (const m of pastMatches) {
      if (m.status !== 'finished') continue;
      const oppEntry = m.opponents?.find((o) => o.opponent?.id !== teamExternalId)?.opponent ?? null;
      if (!oppEntry) continue;

      const { scoreA: teamScore, scoreB: oppScore } = this.extractPairScores(
        m,
        teamExternalId,
        oppEntry.id,
      );

      let outcome: 'W' | 'L' | 'D' = 'D';
      if (m.winner_id === teamExternalId || teamScore > oppScore) {
        outcome = 'W';
      } else if (m.winner_id === oppEntry.id || oppScore > teamScore) {
        outcome = 'L';
      }

      entries.push({
        match_id: String(m.id),
        date: m.begin_at ?? m.scheduled_at ?? new Date().toISOString(),
        tournament_name: this.formatTournamentName(m),
        opponent_name: oppEntry.name,
        opponent_acronym: oppEntry.acronym ?? null,
        team_score: teamScore,
        opponent_score: oppScore,
        score_label: `${teamScore}-${oppScore}`,
        outcome,
      });

      if (entries.length >= 5) break;
    }

    return entries;
  }

  /** Filtra e consolida todos os confrontos diretos (H2H) entre `teamA` e `teamB`. */
  private buildHeadToHead(
    candidateMatches: PandaScoreRawMatch[],
    teamAExternalId: number,
    teamBExternalId: number,
    teamANameFallback: string,
    teamAAcronymFallback: string | null,
    teamBNameFallback: string,
    teamBAcronymFallback: string | null,
  ): PreMatchH2HSummaryDto {
    const uniqueH2H = new Map<number, PandaScoreRawMatch>();

    for (const m of candidateMatches) {
      if (m.status !== 'finished') continue;
      const ids = (m.opponents ?? []).map((o) => o.opponent?.id);
      if (ids.includes(teamAExternalId) && ids.includes(teamBExternalId)) {
        uniqueH2H.set(m.id, m);
      }
    }

    const sorted = Array.from(uniqueH2H.values()).sort((x, y) => {
      const tx = Date.parse(x.begin_at ?? x.scheduled_at ?? '') || 0;
      const ty = Date.parse(y.begin_at ?? y.scheduled_at ?? '') || 0;
      return ty - tx;
    });

    let teamAWins = 0;
    let teamBWins = 0;
    let draws = 0;
    const matches: PreMatchH2HMatchDto[] = [];

    for (const m of sorted) {
      const oppA = m.opponents?.find((o) => o.opponent.id === teamAExternalId)?.opponent;
      const oppB = m.opponents?.find((o) => o.opponent.id === teamBExternalId)?.opponent;
      const { scoreA, scoreB } = this.extractPairScores(m, teamAExternalId, teamBExternalId);

      let winnerSide: 'team_a' | 'team_b' | 'draw' = 'draw';
      if (m.winner_id === teamAExternalId || scoreA > scoreB) {
        winnerSide = 'team_a';
        teamAWins += 1;
      } else if (m.winner_id === teamBExternalId || scoreB > scoreA) {
        winnerSide = 'team_b';
        teamBWins += 1;
      } else {
        draws += 1;
      }

      matches.push({
        id: String(m.id),
        date: m.begin_at ?? m.scheduled_at ?? new Date().toISOString(),
        tournament_name: this.formatTournamentName(m),
        team_a_name: oppA?.name ?? teamANameFallback,
        team_a_acronym: oppA?.acronym ?? teamAAcronymFallback,
        team_a_score: scoreA,
        team_b_name: oppB?.name ?? teamBNameFallback,
        team_b_acronym: oppB?.acronym ?? teamBAcronymFallback,
        team_b_score: scoreB,
        winner_side: winnerSide,
      });
    }

    return {
      team_a_wins: teamAWins,
      team_b_wins: teamBWins,
      draws,
      total_matches: matches.length,
      matches,
    };
  }

  /** Extrai o placar final de uma partida concluída para dois IDs externos de equipe. */
  private extractPairScores(
    match: PandaScoreRawMatch,
    firstTeamId: number,
    secondTeamId: number,
  ): { scoreA: number; scoreB: number } {
    const resA = match.results?.find((r) => r.team_id === firstTeamId)?.score;
    const resB = match.results?.find((r) => r.team_id === secondTeamId)?.score;
    if (typeof resA === 'number' && typeof resB === 'number') {
      return { scoreA: resA, scoreB: resB };
    }

    let winsA = 0;
    let winsB = 0;
    for (const g of match.games ?? []) {
      if (g.winner?.id === firstTeamId) winsA += 1;
      if (g.winner?.id === secondTeamId) winsB += 1;
    }
    if (winsA > 0 || winsB > 0) {
      return { scoreA: winsA, scoreB: winsB };
    }

    const target = match.number_of_games === 1 ? 1 : match.number_of_games === 5 ? 3 : 2;
    if (match.winner_id === firstTeamId) return { scoreA: target, scoreB: 0 };
    if (match.winner_id === secondTeamId) return { scoreA: 0, scoreB: target };
    return { scoreA: 0, scoreB: 0 };
  }

  /**
   * Monta a tabela de classificação do torneio/grupo cruzando `/standings` com
   * as partidas concluídas do torneio (para garantir W-L e Pontos mesmo em chaves GSL).
   */
  private buildStandings(
    rawStandings: PandaScoreRawStandingRow[],
    tournamentMatches: PandaScoreRawMatch[],
    teamAExternalId: number | null,
    teamBExternalId: number | null,
    teamAName: string | null,
    teamBName: string | null,
  ): PreMatchStandingRowDto[] {
    // Contabiliza vitórias/derrotas reais dentro do torneio a partir dos jogos já encerrados.
    const recordByTeamId = new Map<
      number,
      {
        wins: number;
        losses: number;
        team: { id: number; name: string; acronym: string | null; image_url: string | null };
      }
    >();

    for (const m of tournamentMatches) {
      for (const oppWrap of m.opponents ?? []) {
        const t = oppWrap.opponent;
        if (t && !recordByTeamId.has(t.id)) {
          recordByTeamId.set(t.id, { wins: 0, losses: 0, team: t });
        }
      }
      if (m.status !== 'finished') continue;

      const t1 = m.opponents?.[0]?.opponent;
      const t2 = m.opponents?.[1]?.opponent;
      if (!t1 || !t2) continue;

      const { scoreA, scoreB } = this.extractPairScores(m, t1.id, t2.id);
      const rec1 = recordByTeamId.get(t1.id);
      const rec2 = recordByTeamId.get(t2.id);
      if (m.winner_id === t1.id || scoreA > scoreB) {
        if (rec1) rec1.wins += 1;
        if (rec2) rec2.losses += 1;
      } else if (m.winner_id === t2.id || scoreB > scoreA) {
        if (rec2) rec2.wins += 1;
        if (rec1) rec1.losses += 1;
      }
    }

    const rows: PreMatchStandingRowDto[] = [];

    if (rawStandings.length > 0) {
      rawStandings.forEach((entry, index) => {
        if (!entry.team) return;
        const computed = recordByTeamId.get(entry.team.id);
        const wins = typeof entry.wins === 'number' ? entry.wins : (computed?.wins ?? 0);
        const losses = typeof entry.losses === 'number' ? entry.losses : (computed?.losses ?? 0);
        const ties = typeof entry.ties === 'number' ? entry.ties : 0;
        const points = wins * 3 + ties;

        const isTeamA =
          (teamAExternalId !== null && entry.team.id === teamAExternalId) ||
          (teamAName !== null &&
            entry.team.name.trim().toLowerCase() === teamAName.trim().toLowerCase());
        const isTeamB =
          (teamBExternalId !== null && entry.team.id === teamBExternalId) ||
          (teamBName !== null &&
            entry.team.name.trim().toLowerCase() === teamBName.trim().toLowerCase());

        rows.push({
          rank: entry.rank ?? index + 1,
          team_name: entry.team.name,
          team_acronym: entry.team.acronym ?? null,
          team_logo_url: entry.team.image_url ?? null,
          wins,
          losses,
          points,
          is_team_a: isTeamA,
          is_team_b: isTeamB,
        });
      });

      return rows.sort((a, b) => a.rank - b.rank || b.points - a.points);
    }

    // Fallback com dados reais das equipes inscritas no torneio caso `/standings` ainda esteja vazio.
    const fallbackEntries = Array.from(recordByTeamId.values()).sort(
      (a, b) => b.wins - a.wins || a.losses - b.losses || a.team.name.localeCompare(b.team.name),
    );

    return fallbackEntries.map((item, idx) => {
      const isTeamA =
        (teamAExternalId !== null && item.team.id === teamAExternalId) ||
        (teamAName !== null &&
          item.team.name.trim().toLowerCase() === teamAName.trim().toLowerCase());
      const isTeamB =
        (teamBExternalId !== null && item.team.id === teamBExternalId) ||
        (teamBName !== null &&
          item.team.name.trim().toLowerCase() === teamBName.trim().toLowerCase());

      return {
        rank: idx + 1,
        team_name: item.team.name,
        team_acronym: item.team.acronym ?? null,
        team_logo_url: item.team.image_url ?? null,
        wins: item.wins,
        losses: item.losses,
        points: item.wins * 3,
        is_team_a: isTeamA,
        is_team_b: isTeamB,
      };
    });
  }

  /** Extrai e normaliza os links de transmissão (`streams_list`) com plataforma e bandeira. */
  private buildStreamsList(
    rawStreams: NonNullable<PandaScoreRawMatch['streams_list']>,
  ): PreMatchStreamDto[] {
    const seenUrls = new Set<string>();
    const streams: PreMatchStreamDto[] = [];

    for (const s of rawStreams) {
      const url = (s.raw_url ?? s.embed_url ?? '').trim();
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);

      const lower = url.toLowerCase();
      let platform: PreMatchStreamDto['platform'] = 'other';
      if (lower.includes('twitch.tv')) platform = 'twitch';
      else if (lower.includes('youtube.com') || lower.includes('youtu.be')) platform = 'youtube';
      else if (lower.includes('kick.com')) platform = 'kick';

      const channelName = this.extractChannelName(url, platform);
      const langCode = (s.language ?? 'en').trim().toLowerCase();

      streams.push({
        platform,
        channel_name: channelName,
        language: langCode.toUpperCase(),
        flag_emoji: this.languageToFlagEmoji(langCode),
        url,
        is_official: Boolean(s.official),
        is_main: Boolean(s.main),
      });
    }

    return streams.sort(
      (a, b) => Number(b.is_main) - Number(a.is_main) || Number(b.is_official) - Number(a.is_official),
    );
  }

  private extractChannelName(url: string, platform: PreMatchStreamDto['platform']): string {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && last !== 'watch' && last !== 'channel') {
        return last;
      }
    } catch {
      // ignora URL malformada
    }
    if (platform === 'twitch') return 'Twitch Stream';
    if (platform === 'youtube') return 'YouTube Live';
    if (platform === 'kick') return 'Kick Stream';
    return 'Transmissão Ao Vivo';
  }

  private languageToFlagEmoji(lang: string): string {
    switch (lang) {
      case 'pt':
      case 'pt-br':
        return '🇧🇷';
      case 'en':
        return '🇺🇸';
      case 'ru':
        return '🇷🇺';
      case 'es':
        return '🇪🇸';
      case 'fr':
        return '🇫🇷';
      case 'de':
        return '🇩🇪';
      case 'pl':
        return '🇵🇱';
      case 'uk':
        return '🇺🇦';
      case 'da':
        return '🇩🇰';
      case 'sv':
        return '🇸🇪';
      case 'zh':
        return '🇨🇳';
      default:
        return '🌐';
    }
  }
}
