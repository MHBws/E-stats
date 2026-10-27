// =============================================================================
// mobile/src/hooks/useLiveMatch.ts — Hook de Tempo Real do Placar ao Vivo (WS)
// -----------------------------------------------------------------------------
// O QUE: Custom Hook React (`useLiveMatch(matchId)`) que gerencia o ciclo de
//        vida completo do WebSocket em `ws://localhost:3000/ws/live/${matchId}`,
//        expondo `{ liveState, isConnected, error }`.
// POR QUE:
//   1. Estado Completo sem Diffs: Aplica o snapshot `CS2LiveState` diretamente
//      no state do React, validando o número de sequência (`sequence`) para
//      descartar eventuais pacotes fora de ordem.
//   2. Heartbeat Ativo: Responde imediatamente com `{"type":"pong"}` a cada
//      `{"type":"ping"}` enviado pelo BFF a cada 30s, impedindo que o servidor
//      encerre a conexão por inatividade (`ws.terminate()`).
//   3. Exponential Backoff (1s -> 2s -> 4s -> 8s -> 16s): Quando o usuário
//      alterna entre Wi-Fi e 5G ou passa por área sem sinal, reconecta de forma
//      progressiva sem causar *thundering herd* no BFF.
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import type { CS2LiveState, LiveServerMessage } from '../types/match';

/** URL base do WebSocket para desenvolvimento local. */
export const WS_BASE_URL = 'ws://localhost:3000/ws/live';

/** Limite máximo de espera entre tentativas de reconexão (16 segundos). */
const MAX_BACKOFF_MS = 16_000;
/** Atraso inicial da 1ª tentativa de reconexão (1 segundo). */
const INITIAL_BACKOFF_MS = 1_000;

export interface UseLiveMatchResult {
  liveState: CS2LiveState | null;
  isConnected: boolean;
  error: string | null;
}

export function useLiveMatch(matchId: string | null | undefined): UseLiveMatchResult {
  const [liveState, setLiveState] = useState<CS2LiveState | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Guarda o maior `sequence` já aplicado para descartar snapshots obsoletos.
  const lastSequenceRef = useRef<number>(-1);

  useEffect(() => {
    if (!matchId) {
      setLiveState(null);
      setIsConnected(false);
      setError(null);
      return;
    }

    let isUnmounted = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    // Reinicia controle de sequência ao trocar de partida.
    lastSequenceRef.current = -1;

    const connect = (): void => {
      if (isUnmounted) return;

      const url = `${WS_BASE_URL}/${encodeURIComponent(matchId)}`;
      const ws = new WebSocket(url);
      socket = ws;

      ws.onopen = () => {
        if (isUnmounted) {
          ws.close();
          return;
        }
        // Zera o contador do Exponential Backoff assim que a conexão estabiliza.
        attempt = 0;
        setIsConnected(true);
        setError(null);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (isUnmounted) return;

        try {
          const payload = JSON.parse(String(event.data)) as LiveServerMessage;

          // 1. Heartbeat: responde ao Ping do servidor com Pong imediatamente.
          if (payload.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
            return;
          }

          // 2. Atualização do placar ao vivo (hidratação inicial ou Pub/Sub).
          if (payload.type === 'match:state') {
            if (payload.data === null) {
              setLiveState(null);
              return;
            }

            // Garante monotonicidade: nunca sobrescreve um estado mais novo por um antigo.
            if (payload.data.sequence >= lastSequenceRef.current) {
              lastSequenceRef.current = payload.data.sequence;
              setLiveState(payload.data);
            }
            return;
          }

          // 3. Erro reportado pelo servidor.
          if (payload.type === 'error') {
            setError(payload.message);
          }
        } catch {
          setError('Falha ao decodificar mensagem em tempo real do servidor.');
        }
      };

      ws.onerror = () => {
        if (isUnmounted) return;
        setError('Erro na conexão em tempo real com o placar ao vivo.');
      };

      ws.onclose = () => {
        if (isUnmounted) return;
        setIsConnected(false);

        // Exponential Backoff: 1s (2^0 * 1000), 2s (2^1 * 1000), 4s, 8s, máx 16s.
        const backoffDelayMs = Math.min(
          INITIAL_BACKOFF_MS * Math.pow(2, attempt),
          MAX_BACKOFF_MS,
        );
        attempt += 1;

        reconnectTimer = setTimeout(() => {
          connect();
        }, backoffDelayMs);
      };
    };

    connect();

    // Cleanup ao desmontar a tela ou trocar de `matchId`: cancela timer de
    // reconexão e fecha o socket para acionar o `unsubscribe` no Redis do BFF.
    return () => {
      isUnmounted = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.close();
      }
    };
  }, [matchId]);

  return { liveState, isConnected, error };
}
