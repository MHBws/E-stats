// =============================================================================
// src/config/env.ts — Carregamento e validação das variáveis de ambiente
// -----------------------------------------------------------------------------
// O QUE: Lê o .env (via dotenv), valida os valores obrigatórios e expõe um
//        objeto `env` tipado e imutável para o resto da aplicação.
// POR QUE: Centralizar a configuração evita `process.env.X` espalhado pelo
//          código e faz a API falhar RÁPIDO no boot se faltar algo, em vez de
//          quebrar no meio de uma partida ao vivo.
// =============================================================================
import 'dotenv/config';

/** Lê uma variável obrigatória; lança erro descritivo se ausente. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`[config] Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

/** Lê uma variável opcional com valor padrão. */
function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/** Converte para inteiro validando o formato (ex.: portas). */
function toInt(name: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`[config] Variável ${name} deveria ser numérica, recebido: "${raw}"`);
  }
  return parsed;
}

// `as const` + Object.freeze: configuração somente leitura em tempo de
// compilação e de execução.
export const env = Object.freeze({
  nodeEnv: optional('NODE_ENV', 'development'),
  isDev: optional('NODE_ENV', 'development') === 'development',
  host: optional('HOST', '0.0.0.0'),
  port: toInt('PORT', optional('PORT', '3000')),
  logLevel: optional('LOG_LEVEL', 'info'),

  postgres: {
    host: required('POSTGRES_HOST'),
    port: toInt('POSTGRES_PORT', optional('POSTGRES_PORT', '5432')),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    database: required('POSTGRES_DB'),
  },

  redis: {
    host: required('REDIS_HOST'),
    port: toInt('REDIS_PORT', optional('REDIS_PORT', '6379')),
    password: optional('REDIS_PASSWORD', ''),
  },

  providers: {
    citoApiKey: required('CITO_API_KEY'),
    pandaScoreApiKey: optional('PANDASCORE_API_KEY', ''),
  },
  // [UPDATE]: Exposição direta de `PANDASCORE_API_KEY` para validação explícita no adapter.
  PANDASCORE_API_KEY: optional('PANDASCORE_API_KEY', ''),
} as const);

export type Env = typeof env;
