// =============================================================================
// src/workers/cron.manager.ts — Orquestrador de Cron Jobs e Background Workers
// -----------------------------------------------------------------------------
// O QUE: Gerencia as duas rotinas autônomas de background do BFF:
//   1. `schedulePandaScoreSync` (`0 */6 * * *` — a cada 6 horas): sincroniza o
//      calendário de partidas futuras da PandaScore para o PostgreSQL.
//   2. `scheduleLiveWatchdog` (`* * * * *` — a cada 1 minuto): monitora partidas
//      prestes a começar (janela de 15 min) ou já `live` e abre o stream de
//      tempo real na Cito API.
//
// POR QUE ESTA ARQUITETURA TEMPORAL:
//   - Separação Frio vs. Quente: O calendário de torneios muda devagar; rodar o
//     sync REST a cada 6h economiza franquia da API PandaScore (apenas 4 chamadas/dia)
//     mantendo a Home Screen abastecida. Já o início de uma partida exige precisão
//     de minuto para que o placar ao vivo entre no ar sem intervenção humana.
//   - Janela Antecipada de 15 Minutos (`scheduled_at <= NOW() + 15 min`): No CS2,
//     os jogadores entram no servidor ~10-15 min antes do horário oficial para
//     warmup e *knife round* (escolha de lado CT/T), além de agendas "rolling"
//     adiantarem jogos quando a série anterior termina em 2x0 rápido. Conectar
//     15 minutos antes garante captura desde o pistol round com latência zero.
//
// PRECAUÇÃO CONTRA CONEXÕES DUPLICADAS (`activeCitoMatches: Set<string>`):
//   - O Watchdog roda a cada 1 minuto, mas uma série BO3/BO5 dura de 2 a 5 horas
//     (120 a 300 execuções do cron). Sem o `Set<string>` em memória, o worker
//     abriria uma NOVA conexão WebSocket/SSE na Cito a cada minuto para a mesma
//     partida — gerando centenas de conexões duplicadas, estourando rate-limit,
//     publicando eventos repetidos no Redis Pub/Sub e vazando memória.
// =============================================================================
import cron, { type ScheduledTask } from 'node-cron';
import { MappingService, mappingService } from '../core/mapping.service.js';
import { CitoAdapter } from '../providers/cito/cito.adapter.js';
import { PandaScoreAdapter } from '../providers/pandascore/pandascore.adapter.js';

/** Representação enxuta de uma partida elegível para monitoramento ao vivo. */
interface WatchdogCandidateMatch {
  id: string;
  externalCitoId: string;
  status: 'upcoming' | 'scheduled' | 'live';
  scheduledAt: Date;
}

/**
 * Rastreia os `matchId` (UUIDs canônicos) que JÁ possuem conexão ativa na Cito.
 * Lookup O(1) via `Set.has()` impede que o watchdog de 1 minuto abra múltiplos
 * WebSockets concorrentes para o mesmo jogo.
 */
export const activeCitoMatches = new Set<string>();

/** Lista interna das tasks agendadas no `node-cron` para parada limpa no shutdown. */
const scheduledTasks: ScheduledTask[] = [];

// Instâncias padrão reutilizadas pelos workers (permitem injeção caso necessário).
const defaultMapper = new MappingService();
const defaultPandaScoreAdapter = new PandaScoreAdapter(defaultMapper);
const defaultCitoAdapter = new CitoAdapter(defaultMapper);

/**
 * Executa uma passagem de sincronização de partidas futuras na PandaScore.
 * Separada do agendamento para facilitar logs e execução imediata/testes.
 */
export async function runPandaScoreSyncOnce(
  pandaAdapter: PandaScoreAdapter = defaultPandaScoreAdapter,
): Promise<void> {
  try {
    const upcomingMatches = await pandaAdapter.fetchUpcomingMatches();

    // -------------------------------------------------------------------------
    // [SIMULAÇÃO DE PERSISTÊNCIA NO POSTGRESQL — UPSERT DE CALENDÁRIO]
    // Quando conectado ao banco populado em produção, este laço persiste cada
    // partida convertida pelo Adapter e registra o vínculo no MappingService:
    //
    // for (const match of upcomingMatches) {
    //   await db.query(
    //     `INSERT INTO matches (id, tournament_id, team_a_id, team_b_id, format, status, scheduled_at)
    //      VALUES ($1, $2, $3, $4, $5, $6, $7)
    //      ON CONFLICT (id) DO UPDATE
    //        SET status = EXCLUDED.status,
    //            scheduled_at = EXCLUDED.scheduled_at,
    //            team_a_id = EXCLUDED.team_a_id,
    //            team_b_id = EXCLUDED.team_b_id,
    //            updated_at = NOW()`,
    //     [
    //       match.id,
    //       match.tournamentId,
    //       match.teamAId,
    //       match.teamBId,
    //       match.format,
    //       match.status,
    //       match.scheduledAt,
    //     ],
    //   );
    // }
    // -------------------------------------------------------------------------

    console.info(
      `[cron:pandascore] Sincronização concluída: ${upcomingMatches.length} partidas futuras processadas.`,
    );
  } catch (err) {
    console.error('[cron:pandascore] Falha ao sincronizar partidas da PandaScore:', err);
  }
}

// Agenda a sincronização automática com a PandaScore a cada 6 horas ('0 */6 * * *').
export function schedulePandaScoreSync(
  pandaAdapter: PandaScoreAdapter = defaultPandaScoreAdapter,
): ScheduledTask {
  const task = cron.schedule(
    '0 */6 * * *',
    async () => {
      await runPandaScoreSyncOnce(pandaAdapter);
    },
    {
      name: 'pandascore-6h-sync',
      noOverlap: true,
    },
  );

  scheduledTasks.push(task);
  return task;
}

/**
 * Executa uma varredura do Watchdog procurando partidas `live` ou com status
 * `upcoming`/`scheduled` cujo `scheduled_at` esteja a menos de 15 minutos do
 * horário atual.
 */
export async function runLiveWatchdogOnce(
  citoAdapter: CitoAdapter = defaultCitoAdapter,
): Promise<void> {
  try {
    const now = Date.now();
    const fifteenMinutesMs = 15 * 60 * 1_000;

    // -------------------------------------------------------------------------
    // [SIMULAÇÃO DA QUERY SQL DO WATCHDOG]
    // No banco PostgreSQL, buscamos partidas em andamento (`status = 'live'`)
    // ou prestes a iniciar nos próximos 15 minutos (`status IN ('upcoming', 'scheduled')`):
    //
    // const { rows } = await db.query<WatchdogCandidateMatch>(`
    //   SELECT
    //     m.id,
    //     COALESCE(pm.external_id, m.id::text) AS "externalCitoId",
    //     m.status,
    //     m.scheduled_at AS "scheduledAt"
    //   FROM matches m
    //   LEFT JOIN provider_mappings pm
    //     ON pm.entity_id = m.id
    //    AND pm.entity_type = 'match'
    //    AND pm.provider = 'cito'
    //   WHERE m.status = 'live'
    //      OR (
    //        m.status IN ('upcoming', 'scheduled')
    //        AND m.scheduled_at <= NOW() + INTERVAL '15 minutes'
    //        AND m.scheduled_at >= NOW() - INTERVAL '2 hours'
    //      )
    // `);
    // -------------------------------------------------------------------------
    const simulatedCandidates: WatchdogCandidateMatch[] = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        externalCitoId: 'cito_match_990001',
        status: 'upcoming',
        // 10 minutos no futuro (dentro da janela de 15 minutos).
        scheduledAt: new Date(now + 10 * 60 * 1_000),
      },
    ];

    for (const match of simulatedCandidates) {
      const startsWithin15Min = match.scheduledAt.getTime() - now <= fifteenMinutesMs;
      const isEligible =
        match.status === 'live' ||
        ((match.status === 'upcoming' || match.status === 'scheduled') && startsWithin15Min);

      if (!isEligible) continue;

      // PRECAUÇÃO CONTRA DUPLICIDADE: só abre stream na Cito se o `match.id`
      // ainda não estiver registrado no `Set` de conexões ativas.
      if (activeCitoMatches.has(match.id)) {
        continue;
      }

      // Garante que o MappingService conheça o vínculo Cito -> UUID canônico em dev.
      try {
        await mappingService.linkProviderId({
          provider: 'cito',
          entityType: 'match',
          externalId: match.externalCitoId,
          entityId: match.id,
        });
      } catch {
        // Ignorado caso o Postgres não esteja rodando localmente (o CitoAdapter possui fallback).
      }

      citoAdapter.connectToLiveMatch(match.externalCitoId);
      activeCitoMatches.add(match.id);

      console.info(
        `[cron:watchdog] Stream Cito iniciado para a partida ${match.id} (external=${match.externalCitoId}, conexões ativas=${activeCitoMatches.size})`,
      );
    }
  } catch (err) {
    console.error('[cron:watchdog] Erro ao executar verificação de partidas ao vivo:', err);
  }
}

// Agenda o Watchdog de partidas ao vivo para rodar a cada 1 minuto ('* * * * *').
export function scheduleLiveWatchdog(
  citoAdapter: CitoAdapter = defaultCitoAdapter,
): ScheduledTask {
  const task = cron.schedule(
    '* * * * *',
    async () => {
      await runLiveWatchdogOnce(citoAdapter);
    },
    {
      name: 'live-match-watchdog-1m',
      noOverlap: true,
    },
  );

  scheduledTasks.push(task);
  return task;
}

/**
 * Inicializa todos os cron jobs do sistema (chamado no bootstrap do `server.ts`).
 */
export function startAllJobs(deps?: {
  pandaScoreAdapter?: PandaScoreAdapter;
  citoAdapter?: CitoAdapter;
}): void {
  schedulePandaScoreSync(deps?.pandaScoreAdapter);
  scheduleLiveWatchdog(deps?.citoAdapter);
}

/**
 * Desligamento Seguro: interrompe todas as tasks agendadas no `node-cron`,
 * fecha os streams ativos da Cito e limpa o `Set` de partidas monitoradas.
 */
export async function stopAllJobs(citoAdapter: CitoAdapter = defaultCitoAdapter): Promise<void> {
  const tasksToStop = scheduledTasks.splice(0, scheduledTasks.length);
  await Promise.allSettled(tasksToStop.map((task) => Promise.resolve(task.stop())));

  citoAdapter.disconnectAll();
  activeCitoMatches.clear();
}
