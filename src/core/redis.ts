// =============================================================================
// src/core/redis.ts — Clientes Redis (comandos + pub/sub)
// -----------------------------------------------------------------------------
// O QUE: Cria e conecta os clientes Redis usados pela aplicação.
// POR QUE: O Redis é o coração do placar ao vivo: cache quente do estado das
//          partidas e barramento pub/sub para distribuir atualizações aos
//          WebSockets. Um cliente em modo "subscriber" fica bloqueado para
//          outros comandos, por isso mantemos um cliente dedicado para ele.
// =============================================================================
import { createClient } from 'redis';
import { env } from '../config/env.js';

// Monta a URL redis://[:senha@]host:porta a partir da configuração.
const auth = env.redis.password ? `:${encodeURIComponent(env.redis.password)}@` : '';
const url = `redis://${auth}${env.redis.host}:${env.redis.port}`;

/** Cliente para comandos comuns (GET/SET/PUBLISH...). */
export const redis = createClient({ url });

/** Cliente dedicado a SUBSCRIBE (pub/sub do placar ao vivo). */
export const redisSubscriber = redis.duplicate();

// Loga erros de conexão sem derrubar o processo (o client reconecta sozinho).
redis.on('error', (err) => console.error('[redis] Erro no cliente principal:', err));
redisSubscriber.on('error', (err) => console.error('[redis] Erro no subscriber:', err));

/** Conecta ambos os clientes (chamado no bootstrap do servidor). */
export async function connectRedis(): Promise<void> {
  await Promise.all([redis.connect(), redisSubscriber.connect()]);
}

/** Verifica conectividade com o Redis (usado no healthcheck). */
export async function pingRedis(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/** Encerra os clientes de forma graciosa (usado no shutdown). */
export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSubscriber.quit()]);
}
