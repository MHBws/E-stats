// =============================================================================
// src/core/database.ts — Pool de conexões PostgreSQL
// -----------------------------------------------------------------------------
// O QUE: Cria um único Pool do `pg` compartilhado por toda a aplicação.
// POR QUE: Reutilizar conexões evita o custo de handshake TCP/auth a cada
//          query (latência!) e limita o número de conexões abertas no banco.
// =============================================================================
import pg from 'pg';
import { env } from '../config/env.js';

export const db = new pg.Pool({
  host: env.postgres.host,
  port: env.postgres.port,
  user: env.postgres.user,
  password: env.postgres.password,
  database: env.postgres.database,
  // Limite conservador para dev; ajustável por ambiente no futuro.
  max: 10,
  // Fecha conexões ociosas para não segurar recursos do Postgres.
  idleTimeoutMillis: 30_000,
  // Falha rápido se o banco estiver indisponível, em vez de travar requisições.
  connectionTimeoutMillis: 5_000,
});

// Erros em clientes ociosos do pool não devem derrubar o processo.
db.on('error', (err) => {
  console.error('[database] Erro inesperado em cliente ocioso do pool:', err);
});

/** Verifica conectividade com o banco (usado no healthcheck). */
export async function pingDatabase(): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Encerra o pool de forma graciosa (usado no shutdown). */
export async function closeDatabase(): Promise<void> {
  await db.end();
}
