// =============================================================================
// src/core/live-state.cache.ts — Cache e Pub/Sub do placar ao vivo (Redis)
// -----------------------------------------------------------------------------
// O QUE: Funções para salvar/ler o snapshot ao vivo de uma partida e avisar os
//        assinantes de que houve atualização.
// POR QUE: Separamos a CONEXÃO (redis.ts) da LÓGICA de cache do domínio (aqui).
//          Fluxo pensado para baixa latência:
//            provedor -> saveLiveMatchState (SET em memória, O(1))
//                     -> publishLiveUpdate  (PUBLISH, fan-out para N instâncias)
//                     -> cada instância do BFF repassa aos seus WebSockets.
//          O Pub/Sub permite escalar horizontalmente: qualquer instância da API
//          recebe o aviso, não só a que processou o evento do provedor.
// =============================================================================
import type { CS2LiveState } from './models.js';
import { redis } from './redis.js';

/** 12 horas em segundos: cobre com folga uma série BO5 com atrasos/pausas. */
export const LIVE_STATE_TTL_SECONDS = 12 * 60 * 60;

/**
 * Chave do snapshot ao vivo. Centralizada para evitar typos espalhados
 * pelo código e facilitar mudanças de namespace no futuro.
 */
export const liveMatchKey = (matchId: string): string => `match:live:${matchId}`;

/** Canal Pub/Sub de atualizações de uma partida. */
export const matchChannel = (matchId: string): string => `channel:match:${matchId}`;

/** Payload do aviso publicado no canal (propositalmente mínimo). */
export interface LiveUpdateNotice {
  type: 'match:update';
  matchId: string;
  publishedAt: number;
}

/**
 * Salva (sobrescreve) o snapshot ao vivo da partida com TTL de 12h.
 * POR QUE TTL: partidas encerradas/abandonadas expiram sozinhas, evitando que
 * a memória do Redis cresça indefinidamente sem rotina de limpeza.
 * Cada SET renova o TTL, então partidas ativas nunca expiram no meio do jogo.
 */
export async function saveLiveMatchState(matchId: string, state: CS2LiveState): Promise<void> {
  await redis.set(liveMatchKey(matchId), JSON.stringify(state), {
    expiration: { type: 'EX', value: LIVE_STATE_TTL_SECONDS },
  });
}

/**
 * Busca o snapshot ao vivo da partida.
 * Retorna `null` se não existir (partida não iniciada/expirada) ou se o JSON
 * estiver corrompido — o chamador decide o fallback (ex.: buscar no provedor).
 */
export async function getLiveMatchState(matchId: string): Promise<CS2LiveState | null> {
  const raw = await redis.get(liveMatchKey(matchId));
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as CS2LiveState;
  } catch (err) {
    console.error(`[cache] JSON inválido em ${liveMatchKey(matchId)}:`, err);
    return null;
  }
}

/**
 * Publica um aviso de atualização no canal `channel:match:{matchId}`.
 * POR QUE só um aviso (e não o estado completo): mantém o canal leve e o
 * Redis como fonte única da verdade — o assinante lê o snapshot mais recente
 * via getLiveMatchState, evitando aplicar estados intermediários obsoletos.
 * @returns Número de clientes Redis que receberam a mensagem.
 */
export async function publishLiveUpdate(matchId: string): Promise<number> {
  const notice: LiveUpdateNotice = {
    type: 'match:update',
    matchId,
    publishedAt: Date.now(),
  };
  return redis.publish(matchChannel(matchId), JSON.stringify(notice));
}

/**
 * Atalho: salva o snapshot E publica o aviso em UMA ida ao Redis (MULTI/EXEC).
 * POR QUE: economiza um round-trip de rede por evento (latência) e garante
 * atomicidade — nenhum assinante recebe o aviso antes do estado estar gravado.
 */
export async function saveAndPublishLiveState(matchId: string, state: CS2LiveState): Promise<void> {
  const notice: LiveUpdateNotice = { type: 'match:update', matchId, publishedAt: Date.now() };
  await redis
    .multi()
    .set(liveMatchKey(matchId), JSON.stringify(state), {
      expiration: { type: 'EX', value: LIVE_STATE_TTL_SECONDS },
    })
    .publish(matchChannel(matchId), JSON.stringify(notice))
    .exec();
}
