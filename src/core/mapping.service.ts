// =============================================================================
// src/core/mapping.service.ts — Tradução de IDs Externos <-> IDs Canônicos (UUID)
// -----------------------------------------------------------------------------
// O QUE: Gerencia a tabela `provider_mappings`, resolvendo IDs de provedores
//        externos (PandaScore, Cito) para os UUIDs internos do nosso domínio e
//        registrando novos vínculos (upserts idempotentes).
// POR QUE: Isolamento de domínio (Anti-Corruption Layer). A Cito pode identificar
//          uma partida como "cito_98765" e a PandaScore como "1049281", mas para
//          o nosso banco, cache Redis e clientes WebSocket ela é sempre um único
//          UUID canônico. Se trocarmos de provedor no futuro, o app mobile e o
//          histórico de partidas não sofrem impacto.
// =============================================================================
import type pg from 'pg';
import { db } from './database.js';
import type { MappableEntityType, ProviderId, ProviderMapping, UUID } from './models.js';

/** Linha bruta retornada pelo driver `pg` ao consultar `provider_mappings`. */
interface ProviderMappingRow {
  id: string;
  entity_id: string;
  entity_type: MappableEntityType;
  provider: ProviderId;
  external_id: string;
  created_at: Date;
  updated_at: Date;
}

/** Converte snake_case do Postgres para camelCase do Modelo Canônico. */
function mapRowToProviderMapping(row: ProviderMappingRow): ProviderMapping {
  return {
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type,
    provider: row.provider,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Serviço de mapeamento entre IDs de provedores externos e UUIDs canônicos.
 * Recebe o pool do Postgres via construtor (com `db` padrão) para facilitar
 * testes unitários ou uso com PGlite/mocks sem acoplamento rígido.
 */
export class MappingService {
  constructor(private readonly pool: Pick<pg.Pool, 'query'> = db) {}

  /**
   * Busca o UUID interno correspondente a um ID externo de um provedor.
   * POR QUE: Quando um evento em tempo real chega na Cito (ex.: kill na partida
   * externa "98765"), precisamos descobrir em O(log n) — usando o índice único
   * `provider_mappings_external_uq` — qual chave `match:live:{uuid}` atualizar
   * no Redis e em qual canal Pub/Sub publicar.
   */
  async resolveInternalId(
    provider: ProviderId,
    entityType: MappableEntityType,
    externalId: string,
  ): Promise<UUID | null> {
    const result = await this.pool.query<{ entity_id: UUID }>(
      `SELECT entity_id
         FROM provider_mappings
        WHERE provider = $1
          AND entity_type = $2
          AND external_id = $3
        LIMIT 1`,
      [provider, entityType, externalId],
    );

    return result.rows[0]?.entity_id ?? null;
  }

  /**
   * Registra ou atualiza (UPSERT) o vínculo entre uma entidade canônica (UUID)
   * e seu identificador em um provedor externo.
   * POR QUE ON CONFLICT: Sincronizações periódicas de calendário (PandaScore)
   * podem reprocessar partidas já cadastradas; o upsert torna a operação
   * idempotente sem precisar de SELECT prévio (menos round-trips ao banco).
   */
  async linkProviderId(params: {
    provider: ProviderId;
    entityType: MappableEntityType;
    externalId: string;
    entityId: UUID;
  }): Promise<ProviderMapping> {
    const { provider, entityType, externalId, entityId } = params;

    const result = await this.pool.query<ProviderMappingRow>(
      `INSERT INTO provider_mappings (entity_id, entity_type, provider, external_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, entity_type, external_id)
       DO UPDATE SET entity_id = EXCLUDED.entity_id,
                     updated_at = NOW()
       RETURNING id, entity_id, entity_type, provider, external_id, created_at, updated_at`,
      [entityId, entityType, provider, externalId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `[mapping] Falha ao vincular ${provider}:${entityType}:${externalId} -> ${entityId}`,
      );
    }

    return mapRowToProviderMapping(row);
  }
}

/** Instância singleton padrão + helpers funcionais para importação direta. */
export const mappingService = new MappingService();

export const resolveInternalId = (
  provider: ProviderId,
  entityType: MappableEntityType,
  externalId: string,
): Promise<UUID | null> => mappingService.resolveInternalId(provider, entityType, externalId);

export const linkProviderId = (params: {
  provider: ProviderId;
  entityType: MappableEntityType;
  externalId: string;
  entityId: UUID;
}): Promise<ProviderMapping> => mappingService.linkProviderId(params);
