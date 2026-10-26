// =============================================================================
// src/providers/types.ts — Contrato comum dos provedores de dados de Esports
// -----------------------------------------------------------------------------
// O QUE: Define a interface que todo provedor externo (Cito, PandaScore, ...)
//        deve implementar.
// POR QUE: Padrão Adapter — o restante do BFF depende apenas deste contrato,
//          não das APIs externas. Assim podemos trocar/combinar provedores
//          (ex.: Cito para ao vivo, PandaScore como fallback) sem tocar no core.
//          As implementações concretas virão nos próximos módulos.
// =============================================================================

/** Jogos suportados. Foco inicial: CS2. */
export type GameId = 'cs2';

/** Identificadores dos provedores configurados no .env. */
export type ProviderId = 'cito' | 'pandascore';

/** Estado normalizado de uma partida, independente do provedor de origem. */
export interface MatchSnapshot {
  matchId: string;
  game: GameId;
  status: 'scheduled' | 'live' | 'finished';
  teams: [TeamScore, TeamScore];
  /** Timestamp (ms) da última atualização recebida do provedor. */
  updatedAt: number;
  source: ProviderId;
}

export interface TeamScore {
  teamId: string;
  name: string;
  score: number;
}

/** Contrato que cada adapter de provedor deve cumprir. */
export interface EsportsDataProvider {
  readonly id: ProviderId;
  /** Lista partidas ao vivo no momento. */
  getLiveMatches(game: GameId): Promise<MatchSnapshot[]>;
  /**
   * Assina atualizações em tempo real de uma partida.
   * Retorna uma função para cancelar a assinatura.
   */
  subscribeToMatch(matchId: string, onUpdate: (snapshot: MatchSnapshot) => void): () => void;
}
