// =============================================================================
// src/api/live.ws.ts — Canal WebSocket do placar ao vivo
// -----------------------------------------------------------------------------
// O QUE: Expõe GET /ws/live (upgrade para WebSocket).
// POR QUE: WebSocket mantém uma conexão persistente e full-duplex, eliminando
//          o overhead de polling HTTP — requisito para latência quase zero no
//          placar. Neste módulo é apenas um esqueleto (handshake + ping/pong);
//          a integração com o pub/sub do Redis virá nos próximos módulos.
// =============================================================================
import type { FastifyInstance } from 'fastify';

export async function liveWsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws/live', { websocket: true }, (socket, request) => {
    app.log.debug({ ip: request.ip }, '[ws] Cliente conectado');

    // Mensagem de boas-vindas confirmando o handshake ao cliente.
    socket.send(JSON.stringify({ type: 'welcome', timestamp: Date.now() }));

    socket.on('message', (raw) => {
      // Protocolo mínimo: responde "ping" com "pong" (útil para medir RTT).
      try {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Payload JSON inválido' }));
      }
    });

    socket.on('close', () => app.log.debug('[ws] Cliente desconectado'));
  });
}
