// =============================================================================
// mobile/src/types/match.ts — Contratos de Dados (Espelho do BFF E-stats)
// -----------------------------------------------------------------------------
// O QUE: Reúne as tipagens dos endpoints REST (`MatchCardDto`, `MatchDetailDto`)
//        e do canal WebSocket de tempo real (`CS2LiveState` e envelopes WS).
// POR QUE: Garante que o app React Native conheça em tempo de compilação a
//          estrutura exata enviada pelo BFF (Módulos 2, 4 e 5), evitando erros
//          de acesso a propriedades nulas ("undefined is not an object") na UI.
// =============================================================================

export type UUID = string;
export type EpochMs = number;

export type TournamentTier = 'S' | 'A' | 'B' | 'C' | 'D';
export type MatchFormat = 'BO1' | 'BO3' | 'BO5';
// [UPDATE]: Inclui `'not_started'` para compatibilidade direta com status pré-jogo.
export type MatchStatus = 'scheduled' | 'not_started' | 'live' | 'finished' | 'postponed' | 'canceled';
export type MapStatus = 'upcoming' | 'live' | 'finished';
export type ProviderId = 'cito' | 'pandascore';

// -----------------------------------------------------------------------------
// DTOs REST — Home Screen (`GET /api/matches`) & Detalhe (`GET /api/matches/:id`)
// -----------------------------------------------------------------------------

export interface MatchTournamentSummary {
  id: UUID;
  name: string;
  tier: TournamentTier | null;
}

/**
 * [UPDATE]: Jogador do elenco (roster) retornado dentro de `team_a.players` e
 * `team_b.players` no endpoint `GET /api/matches/:id`.
 */
export interface MatchRosterPlayerDto {
  id: string;
  nickname: string;
  first_name: string | null;
  last_name: string | null;
  nationality: string | null;
  image_url: string | null;
  age: number | null;
}

export interface MatchTeamSummary {
  id: UUID;
  name: string;
  acronym: string | null;
  logo_url: string | null;
  // [UPDATE]: Lista opcional de jogadores do time (preenchida no detalhe da partida).
  players?: MatchRosterPlayerDto[];
}

/** Card de partida retornado por `GET /api/matches`. */
export interface MatchCardDto {
  id: UUID;
  format: MatchFormat;
  status: MatchStatus;
  scheduled_at: string;
  winner_id: UUID | null;
  tournament: MatchTournamentSummary;
  /** `null` quando o time ainda não foi definido no chaveamento ("TBD"). */
  team_a: MatchTeamSummary | null;
  team_b: MatchTeamSummary | null;
}

/** Mapa do veto retornado dentro de `MatchDetailDto.maps`. */
export interface MatchMapDetailDto {
  id: UUID;
  map_number: number;
  map_name: string;
  /** `null` quando é o mapa Decider (desempate). */
  pick_team_id: UUID | null;
  status: MapStatus;
  team_a_score: number;
  team_b_score: number;
}

/** [UPDATE]: Placar final consolidado da série em `MatchDetailDto.results`. */
export interface MatchSeriesResultsDto {
  team_a_score: number;
  team_b_score: number;
}

/** [UPDATE]: Estatística individual consolidada pós-jogo (`status === 'finished'`). */
export interface PostMatchPlayerStatDto {
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

/** Detalhe completo da partida retornado por `GET /api/matches/:id`. */
export interface MatchDetailDto extends MatchCardDto {
  maps: MatchMapDetailDto[];
  // [UPDATE]: Placar consolidado e estatísticas finais dos jogadores via PandaScore.
  results?: MatchSeriesResultsDto;
  players_stats?: PostMatchPlayerStatDto[];
}

// -----------------------------------------------------------------------------
// Estado AO VIVO do CS2 — WebSocket (`ws://.../ws/live/:matchId`)
// -----------------------------------------------------------------------------

export type CS2MapName =
  | 'de_ancient'
  | 'de_anubis'
  | 'de_dust2'
  | 'de_inferno'
  | 'de_mirage'
  | 'de_nuke'
  | 'de_overpass'
  | 'de_train'
  | 'de_vertigo'
  | (string & {});

export type CS2Side = 'CT' | 'T';

export type CS2RoundPhase =
  | 'warmup'
  | 'freezetime'
  | 'live'
  | 'bomb_planted'
  | 'round_over'
  | 'halftime'
  | 'timeout'
  | 'map_over';

export type CS2BuyType = 'pistol' | 'eco' | 'semi_eco' | 'force' | 'full';

export type CS2BombState =
  | 'carried'
  | 'dropped'
  | 'planted'
  | 'defusing'
  | 'defused'
  | 'exploded';

export interface CS2Clock {
  remainingMs: number;
  capturedAt: EpochMs;
  running: boolean;
}

export interface CS2TeamEconomy {
  money: number;
  equipmentValue: number;
  lossBonusLevel: number;
  buyType: CS2BuyType | null;
}

// [UPDATE]: Módulo 8 — Estatísticas individuais de jogador (K/D/A e Bank)
// para exibição no resumo rolável da `LiveMatchScreen`.
export interface CS2PlayerLiveStats {
  playerId: string;
  nickname: string;
  kills: number;
  deaths: number;
  assists: number;
  /** Dinheiro atual do jogador no round (Bank em $). */
  money: number;
  alive: boolean;
}

export interface CS2TeamLiveState {
  teamId: UUID;
  name: string;
  acronym: string | null;
  side: CS2Side;
  score: number;
  mapsWon: number;
  playersAlive: number;
  economy: CS2TeamEconomy;
  // [UPDATE]: Módulo 8 — Lista opcional de jogadores do time com K/D/A e Bank.
  players?: CS2PlayerLiveStats[];
}

export interface CS2BombStatus {
  state: CS2BombState;
  site: 'A' | 'B' | null;
  plantedAt: EpochMs | null;
}

export interface CS2PlayerRef {
  playerId: string | null;
  nickname: string;
  teamId: UUID;
}

export interface CS2KillEvent {
  id: string;
  round: number;
  timestamp: EpochMs;
  attacker: CS2PlayerRef | null;
  victim: CS2PlayerRef;
  assister: CS2PlayerRef | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  throughSmoke: boolean;
  noScope: boolean;
}

/** Snapshot completo do placar ao vivo recebido pelo WebSocket. */
export interface CS2LiveState {
  matchId: UUID;
  game: 'cs2';
  status: MatchStatus;
  format: MatchFormat;
  currentMap: {
    mapNumber: number;
    mapName: CS2MapName;
    status: MapStatus;
  };
  round: {
    number: number;
    phase: CS2RoundPhase;
    clock: CS2Clock;
  };
  // [UPDATE]: Módulo 8 — Alias opcional em ms na raiz para compatibilidade direta
  // com leitores que buscam `round_time_remaining_ms` ou `round.clock.remainingMs`.
  round_time_remaining_ms?: number;
  teams: {
    teamA: CS2TeamLiveState;
    teamB: CS2TeamLiveState;
  };
  bomb: CS2BombStatus;
  killfeed: CS2KillEvent[];
  sequence: number;
  updatedAt: EpochMs;
  source: ProviderId;
}

/** Envelopes trafegados no canal WebSocket `/ws/live/:matchId`. */
export type LiveServerMessage =
  | {
      type: 'match:state';
      matchId: string;
      data: CS2LiveState | null;
      timestamp: EpochMs;
    }
  | {
      type: 'ping';
      timestamp: EpochMs;
    }
  | {
      type: 'pong';
      timestamp: EpochMs;
    }
  | {
      type: 'error';
      message: string;
    };

// [UPDATE]: Módulo 8 — Tipagem das rotas do Native Stack Navigator (iOS/Android).
export type RootStackParamList = {
  Home: undefined;
  LiveMatch: {
    matchId: string;
    title?: string;
  };
};
