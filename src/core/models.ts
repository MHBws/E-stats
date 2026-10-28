// =============================================================================
// src/core/models.ts — Modelo Canônico do app
// -----------------------------------------------------------------------------
// O QUE: Tipos TypeScript que representam as entidades do domínio de Esports,
//        independentes de qualquer provedor externo (Cito, PandaScore).
// POR QUE: Os adapters em src/providers TRADUZEM os payloads externos para estes
//          tipos. Assim, API, cache e frontend falam uma única "língua" e trocar
//          ou combinar provedores não afeta o restante do sistema.
//
// Convenções:
//  - Campos em camelCase (o mapeamento a partir do snake_case do Postgres é
//    responsabilidade da camada de repositório).
//  - Datas persistidas = `Date`; timestamps do estado ao vivo = epoch em ms
//    (`number`), pois serializam em JSON sem custo de parse e facilitam cálculos
//    de relógio no cliente.
// =============================================================================

/** UUID v4 em formato string (chaves primárias do banco). */
export type UUID = string;

/** Epoch em milissegundos (Date.now()). */
export type EpochMs = number;

// -----------------------------------------------------------------------------
// Enumerações do domínio (espelham os CHECK constraints do database/init.sql)
// -----------------------------------------------------------------------------

/** Jogos suportados. Foco inicial: CS2. */
export type GameId = 'cs2';

/** Provedores de dados configurados no .env. */
export type ProviderId = 'cito' | 'pandascore';

/** Tier do torneio no padrão de mercado (S = elite ... D = amador). */
export type TournamentTier = 'S' | 'A' | 'B' | 'C' | 'D';

/** Formato da série (melhor de N mapas). */
export type MatchFormat = 'BO1' | 'BO3' | 'BO5';

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'canceled';

export type MapStatus = 'upcoming' | 'live' | 'finished';

/** Tipos de entidade que podem ter IDs externos mapeados. */
export type MappableEntityType = 'tournament' | 'team' | 'match' | 'match_map';

// -----------------------------------------------------------------------------
// Entidades persistidas (1:1 com as tabelas do Postgres)
// -----------------------------------------------------------------------------

/** Colunas de auditoria presentes em todas as tabelas. */
export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/** Tabela `tournaments`. */
export interface Tournament extends Timestamps {
  id: UUID;
  name: string;
  tier: TournamentTier | null;
  startDate: Date | null;
  endDate: Date | null;
  /** Em USD. O driver `pg` retorna NUMERIC como string para não perder precisão. */
  prizePool: string | null;
}

/** Tabela `teams`. */
export interface Team extends Timestamps {
  id: UUID;
  name: string;
  /** Sigla curta usada no placar compacto (ex.: "FUR"). */
  acronym: string | null;
  logoUrl: string | null;
}

/** Tabela `matches` (uma série entre dois times). */
export interface Match extends Timestamps {
  id: UUID;
  tournamentId: UUID;
  /** NULL enquanto o adversário não está definido no chaveamento ("TBD"). */
  teamAId: UUID | null;
  teamBId: UUID | null;
  format: MatchFormat;
  status: MatchStatus;
  scheduledAt: Date;
  winnerId: UUID | null;
}

/** Tabela `match_maps` (cada mapa disputado dentro de uma série). */
export interface MatchMap extends Timestamps {
  id: UUID;
  matchId: UUID;
  /** Ordem do mapa na série (1..5). */
  mapNumber: number;
  mapName: string;
  /** Time que escolheu o mapa; NULL = decider. */
  pickTeamId: UUID | null;
  status: MapStatus;
  /** Placar FINAL de rounds (o placar ao vivo fica no Redis: CS2LiveState). */
  teamAScore: number;
  teamBScore: number;
}

/** Tabela `provider_mappings` (ID externo -> ID interno). */
export interface ProviderMapping extends Timestamps {
  id: UUID;
  entityId: UUID;
  entityType: MappableEntityType;
  provider: ProviderId;
  externalId: string;
}

// -----------------------------------------------------------------------------
// Estado AO VIVO do CS2 (armazenado no Redis, nunca no Postgres)
// -----------------------------------------------------------------------------
// POR QUE no Redis: este objeto muda várias vezes por segundo (kills, bomba,
// dinheiro). Gravar isso no Postgres geraria contenção e latência; no Redis é
// uma única escrita em memória, lida por todos os WebSockets da partida.
// O payload é propositalmente compacto para minimizar bytes trafegados.

/** Mapas do Active Duty do CS2 (string livre aceita para mapas novos/fora do pool). */
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
  | (string & {}); // mantém o autocomplete sem rejeitar mapas desconhecidos

/** Lado do time no mapa atual. */
export type CS2Side = 'CT' | 'T';

/** Fase do round, usada para decidir o que o placar exibe (relógio, timeout etc.). */
export type CS2RoundPhase =
  | 'warmup'
  | 'freezetime' // compra de equipamentos
  | 'live' // round em andamento
  | 'bomb_planted'
  | 'round_over'
  | 'halftime'
  | 'timeout' // pausa tática/técnica
  | 'map_over';

/** Classificação da compra do time no round (exibida como contexto no placar). */
export type CS2BuyType = 'pistol' | 'eco' | 'semi_eco' | 'force' | 'full';

/** Ciclo de vida da C4. */
export type CS2BombState =
  | 'carried' // com algum T
  | 'dropped' // no chão
  | 'planted'
  | 'defusing'
  | 'defused'
  | 'exploded';

/**
 * Relógio do round.
 * POR QUE assim: em vez de enviar um update por segundo, enviamos o tempo
 * restante + o instante da captura; o cliente interpola localmente
 * (`remainingMs - (agora - capturedAt)`), reduzindo tráfego e mantendo a
 * contagem fluida mesmo com jitter de rede.
 */
export interface CS2Clock {
  remainingMs: number;
  capturedAt: EpochMs;
  /** false durante pausas/timeouts: o cliente congela a contagem. */
  running: boolean;
}

/** Economia do time no round atual. */
export interface CS2TeamEconomy {
  /** Soma do dinheiro em caixa dos 5 jogadores. */
  money: number;
  /** Valor total do equipamento em mãos (indica a força da compra). */
  equipmentValue: number;
  /** Bônus de derrotas consecutivas acumulado (0..4 no CS2). */
  lossBonusLevel: number;
  buyType: CS2BuyType | null;
}

/** Estatísticas individuais em tempo real de um jogador no mapa atual. */
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

/** Placar e contexto de um time no mapa atual. */
export interface CS2TeamLiveState {
  teamId: UUID;
  name: string;
  acronym: string | null;
  side: CS2Side;
  /** Rounds vencidos no mapa atual. */
  score: number;
  /** Mapas vencidos na série. */
  mapsWon: number;
  playersAlive: number;
  economy: CS2TeamEconomy;
  /** [UPDATE]: Jogadores do time com K/D/A, Bank e status vivo/eliminado vindos da Cito. */
  players?: CS2PlayerLiveStats[];
}

/** Status da bomba no round atual. */
export interface CS2BombStatus {
  state: CS2BombState;
  /** Bombsite, quando plantada. */
  site: 'A' | 'B' | null;
  /** Momento do plant: o cliente calcula a contagem regressiva de 40s localmente. */
  plantedAt: EpochMs | null;
}

/** Referência leve a um jogador dentro do killfeed. */
export interface CS2PlayerRef {
  /** ID externo/interno do jogador (players ainda não são entidade persistida). */
  playerId: string | null;
  nickname: string;
  teamId: UUID;
}

/** Uma entrada do killfeed. */
export interface CS2KillEvent {
  /** ID único do evento: permite deduplicar quando o mesmo kill chega duas vezes. */
  id: string;
  round: number;
  timestamp: EpochMs;
  /** NULL quando a morte não tem autor (queda, bomba, suicídio). */
  attacker: CS2PlayerRef | null;
  victim: CS2PlayerRef;
  assister: CS2PlayerRef | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  throughSmoke: boolean;
  noScope: boolean;
}

/**
 * Snapshot completo do placar ao vivo de uma partida de CS2.
 * Gravado em `match:live:{matchId}` e enviado aos clientes via WebSocket.
 */
export interface CS2LiveState {
  matchId: UUID;
  game: 'cs2';
  status: MatchStatus;
  format: MatchFormat;

  /** Mapa em disputa no momento. */
  currentMap: {
    mapNumber: number;
    mapName: CS2MapName;
    status: MapStatus;
  };

  /** Round atual (número, fase e relógio). */
  round: {
    number: number;
    phase: CS2RoundPhase;
    clock: CS2Clock;
  };

  /** Times sempre na mesma ordem de `matches.team_a_id` / `team_b_id`. */
  teams: {
    teamA: CS2TeamLiveState;
    teamB: CS2TeamLiveState;
  };

  bomb: CS2BombStatus;

  /** Killfeed recente (ex.: últimos 10 eventos), do mais novo para o mais antigo. */
  killfeed: CS2KillEvent[];

  /**
   * Número de sequência monotônico do snapshot.
   * POR QUE: eventos de rede podem chegar fora de ordem; o cliente/servidor
   * descarta qualquer snapshot com sequence menor que o último aplicado.
   */
  sequence: number;
  /** Momento em que o BFF gerou este snapshot. */
  updatedAt: EpochMs;
  /** Provedor que originou o dado (útil para debug e failover). */
  source: ProviderId;
}
