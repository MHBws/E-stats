// =============================================================================
// src/api/live.ws.ts — Canal WebSocket do placar ao vivo + Pub/Sub + Heartbeat
// -----------------------------------------------------------------------------
// O QUE: Expõe GET /ws/live/:matchId (upgrade para WebSocket), hidrata o
//        cliente imediatamente com o snapshot atual do Redis, inscreve a
//        conexão no canal Pub/Sub da partida e monitora conexões zumbis via
//        Heartbeat (Ping/Pong) a cada 30 segundos.
// POR QUE:
//   1. Latência Quase Zero (estilo Apple Sports): Ao conectar, o cliente recebe
//      o `CS2LiveState` completo direto da RAM (Redis) sem esperar o próximo
//      evento da partida.
//   2. Escalabilidade Horizontal: O fan-out via Redis Pub/Sub permite que N
//      instâncias da API entreguem eventos em tempo real para milhares de
//      espectadores simultâneos.
//   3. Limpeza de Memória e Resiliência Mobile: Redes móveis (4G/5G/troca de
//      Wi-Fi) frequentemente deixam conexões TCP "meio-abertas" (half-open) sem
//      enviar pacote FIN. O Heartbeat detecta clientes silenciosos, executa
//      `ws.terminate()` e faz `unsubscribe` do Redis para evitar memory leaks.
// =============================================================================
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
// [UPDATE]: Módulo 4 — Importa cache de estado ao vivo e cliente Redis Pub/Sub.
import { getLiveMatchState, matchChannel } from '../core/live-state.cache.js';
import { redisSubscriber } from '../core/redis.js';

// [UPDATE]: Módulo 4 — Intervalo de 30s para o Heartbeat (Ping/Pong).
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Metadados de cada conexão ativa para controle de Heartbeat e limpeza. */
interface TrackedClient {
  socket: WebSocket;
  matchId: string;
  isAlive: boolean;
  cleanup: () => Promise<void>;
}

export async function liveWsRoutes(app: FastifyInstance): Promise<void> {
  // [UPDATE]: Módulo 4 — Conjunto de clientes ativos monitorados pelo Heartbeat.
  const trackedClients = new Set<TrackedClient>();

  // [UPDATE]: Módulo 4 — Loop de Heartbeat que varre todos os clientes a cada 30s.
  // Se `isAlive` continuou `false` desde o último ciclo, a conexão caiu de forma
  // silenciosa: encerramos com `terminate()` e limpamos a inscrição no Redis.
  const heartbeatTimer = setInterval(() => {
    for (const client of trackedClients) {
      if (!client.isAlive) {
        app.log.debug(
          { matchId: client.matchId },
          '[ws] Cliente sem resposta ao ping (timeout); encerrando conexão e limpando Pub/Sub',
        );
        client.socket.terminate();
        void client.cleanup();
        continue;
      }

      // Marca como inativo até que o cliente responda com pong (frame WS ou JSON).
      client.isAlive = false;
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.ping();
        client.socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // `unref()` evita que o timer impeça o encerramento do processo Node.
  heartbeatTimer.unref();

  // Garante limpeza do intervalo quando o servidor Fastify fecha (hot reload / shutdown).
  app.addHook('onClose', async () => {
    clearInterval(heartbeatTimer);
    await Promise.allSettled(Array.from(trackedClients, (c) => c.cleanup()));
  });

  // [UPDATE]: Módulo 4 — Rota parametrizada `/ws/live/:matchId` para assinar uma
  // partida específica de CS2.
  app.get<{ Params: { matchId: string } }>(
    '/ws/live/:matchId',
    { websocket: true },
    async (socket, request) => {
      const { matchId } = request.params;
      const channel = matchChannel(matchId);

      app.log.debug({ ip: request.ip, matchId }, '[ws] Cliente conectado à partida');

      // -----------------------------------------------------------------------
      // Callback disparado pelo Redis Pub/Sub sempre que a partida sofre update.
      // POR QUE buscamos `getLiveMatchState(matchId)` do Redis: O canal Pub/Sub
      // trafega um aviso leve (`LiveUpdateNotice`), mantendo o cache Redis como
      // fonte única da verdade e garantindo que o cliente sempre receba o
      // snapshot completo mais recente (`CS2LiveState`).
      // -----------------------------------------------------------------------
      const onRedisMessage = async (rawMessage: string): Promise<void> => {
        if (socket.readyState !== socket.OPEN) return;

        try {
          const latestState = await getLiveMatchState(matchId);
          if (latestState && socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'match:state',
                matchId,
                data: latestState,
                timestamp: Date.now(),
              }),
            );
            return;
          }

          // Fallback: caso alguém tenha publicado o próprio payload no canal.
          const parsed = JSON.parse(rawMessage) as unknown;
          if (socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                type: 'match:state',
                matchId,
                data: parsed,
                timestamp: Date.now(),
              }),
            );
          }
        } catch (err) {
          app.log.error({ err, matchId }, '[ws] Erro ao repassar atualização do Redis ao cliente');
        }
      };

      // -----------------------------------------------------------------------
      // Limpeza idempotente da conexão (executada no `close`, `error` ou no
      // `terminate()` do Heartbeat).
      // POR QUE passar `onRedisMessage` no `unsubscribe`: O `@redis/client`
      // mantém um Set de listeners por canal. Passando a referência exata do
      // listener deste socket, removemos APENAS este cliente sem derrubar a
      // inscrição dos demais espectadores da mesma partida, e liberamos o canal
      // no Redis automaticamente quando o último espectador sair.
      // -----------------------------------------------------------------------
      let cleanedUp = false;
      const cleanup = async (): Promise<void> => {
        if (cleanedUp) return;
        cleanedUp = true;
        trackedClients.delete(clientRecord);

        try {
          if (redisSubscriber.isOpen) {
            await redisSubscriber.unsubscribe(channel, onRedisMessage);
          }
        } catch (err) {
          app.log.error({ err, channel }, '[ws] Erro ao fazer unsubscribe no Redis');
        }
      };

      const clientRecord: TrackedClient = {
        socket,
        matchId,
        isAlive: true,
        cleanup,
      };
      trackedClients.add(clientRecord);

      // Resposta ao frame nativo de Pong do protocolo WebSocket (RFC 6455).
      socket.on('pong', () => {
        clientRecord.isAlive = true;
      });

      // Resposta a mensagens JSON enviadas pelo app mobile (ping ou pong).
      socket.on('message', (raw) => {
        clientRecord.isAlive = true;
        try {
          const message = JSON.parse(raw.toString()) as { type?: string };
          if (message.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          } else if (message.type === 'pong') {
            // Confirmado pelo cliente no nível de aplicação; `isAlive` já foi renovado.
          }
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Payload JSON inválido' }));
        }
      });

      // AÇÃO AO DESCONECTAR: remove listener do Redis Pub/Sub para evitar memory leak.
      socket.on('close', () => {
        app.log.debug({ matchId }, '[ws] Cliente desconectado; limpando inscrição Pub/Sub');
        void cleanup();
      });

      socket.on('error', (err) => {
        app.log.warn({ err, matchId }, '[ws] Erro no socket do cliente; limpando recursos');
        void cleanup();
      });

      // -----------------------------------------------------------------------
      // AÇÕES AO CONECTAR:
      //   a) Busca o estado atual no Redis (`getLiveMatchState`) e envia
      //      imediatamente para hidratar a UI sem tela de espera.
      //   b) Inscreve a conexão no canal `channel:match:{matchId}` via
      //      `redisSubscriber` para receber atualizações em tempo real.
      // -----------------------------------------------------------------------
      try {
        const initialState = await getLiveMatchState(matchId);
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'match:state',
              matchId,
              data: initialState,
              timestamp: Date.now(),
            }),
          );
        }

        if (!cleanedUp && socket.readyState === socket.OPEN) {
          await redisSubscriber.subscribe(channel, onRedisMessage);
        }
      } catch (err) {
        app.log.error({ err, matchId }, '[ws] Falha ao inicializar estado/PubSub da partida');
        if (socket.readyState === socket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: 'Não foi possível assinar atualizações em tempo real desta partida',
            }),
          );
        }
        await cleanup();
      }
    },
  );
}
