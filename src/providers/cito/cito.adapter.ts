// =============================================================================
// src/providers/cito/cito.adapter.ts — Adapter de Tempo Real da Cito API
// -----------------------------------------------------------------------------
// O QUE: Gerencia o stream de eventos ao vivo (WebSocket/SSE) da Cito API para
//        partidas de CS2, traduzindo eventos brutos (kill, bomb_planted,
//        round_end) em snapshots canônicos `CS2LiveState` e publicando-os no
//        Redis via `saveAndPublishLiveState`.
// POR QUE: A Cito emite eventos granulares em altíssima frequência. Ao
//          resolver o UUID interno via `MappingService`, consolidar o estado
//          em `CS2LiveState` e gravar + publicar no Redis em uma única
//          transação (`MULTI/EXEC`), desacoplamos a ingestão externa da
//          entrega para milhares de clientes mobile conectados no nosso BFF.
// =============================================================================
import { env } from '../../config/env.js';
import { saveAndPublishLiveState } from '../../core/live-state.cache.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type { CS2KillEvent, CS2LiveState, UUID } from '../../core/models.js';

/** Eventos brutos simulados que chegam pelo stream de tempo real da Cito. */
export type CitoRawLiveEvent =
  | {
      type: 'kill';
      externalMatchId: string;
      round: number;
      attackerNick: string;
      victimNick: string;
      weapon: string;
      headshot: boolean;
    }
  | {
      type: 'round_end';
      externalMatchId: string;
      round: number;
      winnerSide: 'CT' | 'T';
      teamAScore: number;
      teamBScore: number;
    };

/** UUID de fallback para testes em dev quando a partida não está no banco. */
const DEV_FALLBACK_MATCH_UUID: UUID = '00000000-0000-4000-8000-000000000001';
const DEV_TEAM_A_UUID: UUID = '00000000-0000-4000-8000-0000000000a1';
const DEV_TEAM_B_UUID: UUID = '00000000-0000-4000-8000-0000000000b2';

export class CitoAdapter {
  readonly providerId = 'cito' as const;
  private sequenceCounter = 0;
  private readonly activeStreams = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly mapper: MappingService = mappingService,
    private readonly apiKey: string = env.providers.citoApiKey,
  ) {}

  /**
   * Inicia a escuta de eventos em tempo real de uma partida na Cito.
   * Retorna uma função `disconnect()` para encerrar o stream e limpar timers
   * (evitando vazamento de memória quando a partida termina).
   */
  connectToLiveMatch(externalMatchId: string): { disconnect: () => void } {
    void this.apiKey; // será enviado no header de autenticação do WebSocket real

    // Evita abrir dois streams duplicados para a mesma partida externa.
    this.disconnectFromLiveMatch(externalMatchId);

    // Simula a chegada de eventos em tempo real (kill -> round_end) em loop
    // para alimentar o Redis durante o desenvolvimento local.
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      const simulatedEvent: CitoRawLiveEvent =
        tick % 2 === 1
          ? {
              type: 'kill',
              externalMatchId,
              round: 14,
              attackerNick: 'KSCERATO',
              victimNick: 'ZywOo',
              weapon: 'ak47',
              headshot: true,
            }
          : {
              type: 'round_end',
              externalMatchId,
              round: 14,
              winnerSide: 'T',
              teamAScore: 8,
              teamBScore: 6,
            };

      void this.handleIncomingEvent(simulatedEvent);
    }, 5_000);

    // `unref()` permite que o processo Node encerre normalmente sem ficar preso
    // por este timer caso nenhum servidor HTTP esteja ativo.
    timer.unref();
    this.activeStreams.set(externalMatchId, timer);

    return {
      disconnect: () => this.disconnectFromLiveMatch(externalMatchId),
    };
  }

  /**
   * Processa um único evento da Cito (pode ser chamado diretamente em testes
   * ou pelo listener do stream em tempo real):
   *   a) Resolve o UUID canônico da partida via `MappingService`.
   *   b) Constrói o snapshot `CS2LiveState` atualizado.
   *   c) Persiste no Redis e publica no canal Pub/Sub via `saveAndPublishLiveState`.
   */
  async handleIncomingEvent(event: CitoRawLiveEvent): Promise<CS2LiveState> {
    // (a) Descobre nosso `matchId` interno a partir do ID externo da Cito.
    let internalMatchId: UUID | null = null;
    try {
      internalMatchId = await this.mapper.resolveInternalId(
        this.providerId,
        'match',
        event.externalMatchId,
      );
    } catch {
      // Se o banco não estiver acessível no ambiente local, usa UUID de fallback.
      internalMatchId = null;
    }

    const matchId: UUID = internalMatchId ?? DEV_FALLBACK_MATCH_UUID;

    // (b) Constrói o snapshot atualizado do `CS2LiveState`.
    const liveState = this.buildLiveStateSnapshot(matchId, event);

    // (c) Salva em `match:live:{matchId}` (TTL 12h) e publica em `channel:match:{matchId}`.
    await saveAndPublishLiveState(matchId, liveState);

    return liveState;
  }

  /** Encerra o stream de uma partida específica e limpa seu timer. */
  disconnectFromLiveMatch(externalMatchId: string): void {
    const existing = this.activeStreams.get(externalMatchId);
    if (existing) {
      clearInterval(existing);
      this.activeStreams.delete(externalMatchId);
    }
  }

  /** Encerra todos os streams ativos (usado no graceful shutdown do servidor). */
  disconnectAll(): void {
    for (const externalId of this.activeStreams.keys()) {
      this.disconnectFromLiveMatch(externalId);
    }
  }

  /** Monta um snapshot completo de `CS2LiveState` refletindo o último evento. */
  private buildLiveStateSnapshot(matchId: UUID, event: CitoRawLiveEvent): CS2LiveState {
    const now = Date.now();
    this.sequenceCounter += 1;

    const isRoundEnd = event.type === 'round_end';
    const teamAScore = isRoundEnd ? event.teamAScore : 7;
    const teamBScore = isRoundEnd ? event.teamBScore : 6;

    const killfeed: CS2KillEvent[] =
      event.type === 'kill'
        ? [
            {
              id: `cito-kill-${this.sequenceCounter}`,
              round: event.round,
              timestamp: now,
              attacker: {
                playerId: 'player-kscerato',
                nickname: event.attackerNick,
                teamId: DEV_TEAM_A_UUID,
              },
              victim: {
                playerId: 'player-zywoo',
                nickname: event.victimNick,
                teamId: DEV_TEAM_B_UUID,
              },
              assister: null,
              weapon: event.weapon,
              headshot: event.headshot,
              wallbang: false,
              throughSmoke: false,
              noScope: false,
            },
          ]
        : [];

    return {
      matchId,
      game: 'cs2',
      status: 'live',
      format: 'BO3',
      currentMap: {
        mapNumber: 1,
        mapName: 'de_mirage',
        status: 'live',
      },
      round: {
        number: event.round,
        phase: isRoundEnd ? 'round_over' : 'live',
        clock: {
          remainingMs: isRoundEnd ? 5_000 : 72_000,
          capturedAt: now,
          running: true,
        },
      },
      teams: {
        teamA: {
          teamId: DEV_TEAM_A_UUID,
          name: 'FURIA',
          acronym: 'FUR',
          side: 'T',
          score: teamAScore,
          mapsWon: 0,
          playersAlive: isRoundEnd ? 3 : 4,
          economy: {
            money: 14_200,
            equipmentValue: 24_500,
            lossBonusLevel: 1,
            buyType: 'full',
          },
        },
        teamB: {
          teamId: DEV_TEAM_B_UUID,
          name: 'Team Vitality',
          acronym: 'VIT',
          side: 'CT',
          score: teamBScore,
          mapsWon: 0,
          playersAlive: isRoundEnd ? 0 : 3,
          economy: {
            money: 9_800,
            equipmentValue: 26_100,
            lossBonusLevel: 2,
            buyType: 'full',
          },
        },
      },
      bomb: {
        state: 'carried',
        site: null,
        plantedAt: null,
      },
      killfeed,
      sequence: this.sequenceCounter,
      updatedAt: now,
      source: this.providerId,
    };
  }
}
