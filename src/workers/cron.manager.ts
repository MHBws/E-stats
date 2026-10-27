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
//
// [UPDATE]: HANDOFF PandaScore -> Cito Sports. Logo após cada sync, as partidas
//   que a PandaScore retornou como `running` (AO VIVO) são entregues
//   imediatamente à Cito (`handoffLiveMatchesToCito`), sem esperar o próximo
//   minuto do watchdog. O watchdog continua como rede de segurança para jogos
//   que começam entre dois syncs de 6h.
// =============================================================================
import cron, { type ScheduledTask } from 'node-cron';
// [UPDATE]: Consulta real ao PostgreSQL no Watchdog ao vivo.
import { db } from '../core/database.js';
import type { MatchFormat, UUID } from '../core/models.js';
import { MappingService } from '../core/mapping.service.js';
import { CitoAdapter, type LiveTrackingTarget } from '../providers/cito/cito.adapter.js';
import { PandaScoreAdapter } from '../providers/pandascore/pandascore.adapter.js';

/**
 * [UPDATE]: Linha retornada pelo PostgreSQL com tudo que a Cito precisa para
 * localizar a partida (nomes/siglas dos times para o pareamento de IDs).
 */
interface TrackingTargetRow {
  id: UUID;
  format: MatchFormat;
  teamAId: UUID | null;
  teamAName: string | null;
  teamAAcronym: string | null;
  teamBId: UUID | null;
  teamBName: string | null;
  teamBAcronym: string | null;
}

/**
 * Rastreia os `matchId` (UUIDs canônicos) que JÁ possuem conexão ativa na Cito.
 * Lookup O(1) via `Set.has()` impede que o watchdog de 1 minuto abra múltiplos
 * streams concorrentes para o mesmo jogo.
 */
export const activeCitoMatches = new Set<string>();

/** Lista interna das tasks agendadas no `node-cron` para parada limpa no shutdown. */
const scheduledTasks: ScheduledTask[] = [];

// Instâncias padrão reutilizadas pelos workers (permitem injeção caso necessário).
const defaultMapper = new MappingService();
// [UPDATE]: Instâncias "ativas" — quando o `server.ts` registra seus adapters nos
// agendadores, a rota manual `/api/sync/force` passa a reutilizar as MESMAS
// instâncias. POR QUE: sessões de polling da Cito vivem em memória no adapter;
// duas instâncias diferentes poderiam monitorar o mesmo jogo em duplicidade e o
// shutdown só encerraria uma delas.
let activePandaScoreAdapter = new PandaScoreAdapter(defaultMapper);
let activeCitoAdapter = new CitoAdapter(defaultMapper);

/** Converte a linha do banco no alvo de monitoramento esperado pela Cito. */
function toTrackingTarget(row: TrackingTargetRow): LiveTrackingTarget {
  return {
    matchId: row.id,
    format: row.format,
    teamA: { id: row.teamAId, name: row.teamAName, acronym: row.teamAAcronym },
    teamB: { id: row.teamBId, name: row.teamBName, acronym: row.teamBAcronym },
  };
}

/** SELECT base com os times da partida (sem filtro). */
const TRACKING_TARGET_SELECT = `
  SELECT
    m.id,
    m.format,
    ta.id      AS "teamAId",
    ta.name    AS "teamAName",
    ta.acronym AS "teamAAcronym",
    tb.id      AS "teamBId",
    tb.name    AS "teamBName",
    tb.acronym AS "teamBAcronym"
  FROM matches m
  LEFT JOIN teams ta ON ta.id = m.team_a_id
  LEFT JOIN teams tb ON tb.id = m.team_b_id
`;

/**
 * [UPDATE]: Entrega uma lista de partidas à Cito Sports, respeitando o `Set`
 * anti-duplicidade. Retorna quantas passaram a ser monitoradas agora.
 */
async function startTrackingTargets(
  targets: LiveTrackingTarget[],
  citoAdapter: CitoAdapter,
  origin: 'handoff' | 'watchdog',
): Promise<number> {
  let started = 0;

  for (const target of targets) {
    // PRECAUÇÃO CONTRA DUPLICIDADE: pula partidas já monitoradas.
    if (activeCitoMatches.has(target.matchId) || citoAdapter.isTracking(target.matchId)) continue;

    // Partidas "TBD" (sem os dois times) não podem ser pareadas na Cito.
    if (!target.teamA.name || !target.teamB.name) continue;

    try {
      const ok = await citoAdapter.startLiveTracking(target, (endedMatchId) => {
        // Callback de encerramento: libera a vaga no `Set` quando a Cito
        // reporta fim de jogo (ou após falhas definitivas), evitando que uma
        // partida encerrada fique "presa" em memória para sempre.
        activeCitoMatches.delete(endedMatchId);
      });

      if (ok) {
        activeCitoMatches.add(target.matchId);
        started += 1;
        console.info(
          `[cron:${origin}] Cito monitorando ${target.teamA.name} vs ${target.teamB.name} (${target.matchId}); conexões ativas=${activeCitoMatches.size}`,
        );
      }
    } catch (err) {
      console.error(
        `[cron:${origin}] Falha ao iniciar Cito para a partida ${target.matchId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return started;
}

/**
 * [UPDATE]: HANDOFF IMEDIATO — recebe os UUIDs das partidas que a PandaScore
 * acabou de reportar como AO VIVO e aciona a Cito Sports para cada uma.
 */
export async function handoffLiveMatchesToCito(
  matchIds: UUID[],
  citoAdapter: CitoAdapter = activeCitoAdapter,
): Promise<number> {
  if (matchIds.length === 0) return 0;

  if (!citoAdapter.isConfigured()) {
    console.error(
      `[cron:handoff] ${matchIds.length} partida(s) ao vivo não serão monitoradas: CITO_API_KEY ausente ou fake. Configure uma chave real no .env.`,
    );
    return 0;
  }

  const { rows } = await db.query<TrackingTargetRow>(
    `${TRACKING_TARGET_SELECT} WHERE m.id = ANY($1::uuid[])`,
    [matchIds],
  );
  return startTrackingTargets(rows.map(toTrackingTarget), citoAdapter, 'handoff');
}

/**
 * Executa uma passagem de sincronização de partidas futuras na PandaScore.
 * Separada do agendamento para facilitar logs e execução imediata/testes.
 */
export async function runPandaScoreSyncOnce(
  pandaAdapter: PandaScoreAdapter = activePandaScoreAdapter,
  citoAdapter: CitoAdapter = activeCitoAdapter,
): Promise<number> {
  let syncedCount = 0;
  try {
    // [UPDATE]: Chama `syncMatches()` para buscar na PandaScore e fazer UPSERT real
    // de torneios, times, partidas, mapas e vínculos no PostgreSQL.
    const syncedMatches = await pandaAdapter.syncMatches();
    syncedCount = syncedMatches.length;

    console.info(
      `[cron:pandascore] Sincronização concluída: ${syncedCount} partidas persistidas no banco.`,
    );
  } catch (err) {
    console.error('[cron:pandascore] Falha ao sincronizar partidas da PandaScore:', err);
    throw err;
  }

  // [UPDATE]: Handoff das partidas AO VIVO para a Cito. Erros aqui NÃO derrubam
  // o sync do calendário (as partidas já foram salvas com sucesso).
  try {
    await handoffLiveMatchesToCito(pandaAdapter.lastSyncLiveMatchIds, citoAdapter);
  } catch (err) {
    console.error('[cron:handoff] Falha no handoff de partidas ao vivo para a Cito:', err);
  }

  return syncedCount;
}

// Agenda a sincronização automática com a PandaScore a cada 6 horas ('0 */6 * * *').
export function schedulePandaScoreSync(
  pandaAdapter: PandaScoreAdapter = activePandaScoreAdapter,
): ScheduledTask {
  // [UPDATE]: Registra a instância como ativa para reuso pela rota manual.
  activePandaScoreAdapter = pandaAdapter;

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
  citoAdapter: CitoAdapter = activeCitoAdapter,
): Promise<void> {
  try {
    // [UPDATE]: Sem chave válida da Cito não há o que monitorar; registra o
    // erro UMA vez por ciclo (em vez de uma vez por partida).
    if (!citoAdapter.isConfigured()) {
      console.error(
        '[cron:watchdog] CITO_API_KEY ausente ou fake: monitoramento ao vivo desativado. Configure uma chave real no .env.',
      );
      return;
    }

    // [UPDATE]: Busca partidas `live` ou prestes a iniciar (janela de 15 min
    // antes até 2h depois do horário oficial), já com os nomes dos times para
    // o pareamento na Cito. Se a Cito ainda não listar o jogo como ao vivo, o
    // `startLiveTracking` retorna `false` e tentamos de novo no próximo minuto.
    const { rows } = await db.query<TrackingTargetRow>(`
      ${TRACKING_TARGET_SELECT}
      WHERE m.status = 'live'
         OR (
           m.status IN ('upcoming', 'scheduled')
           AND m.scheduled_at <= NOW() + INTERVAL '15 minutes'
           AND m.scheduled_at >= NOW() - INTERVAL '2 hours'
         )
    `);

    await startTrackingTargets(rows.map(toTrackingTarget), citoAdapter, 'watchdog');
  } catch (err) {
    console.error('[cron:watchdog] Erro ao executar verificação de partidas ao vivo:', err);
  }
}

// Agenda o Watchdog de partidas ao vivo para rodar a cada 1 minuto ('* * * * *').
export function scheduleLiveWatchdog(
  citoAdapter: CitoAdapter = activeCitoAdapter,
): ScheduledTask {
  // [UPDATE]: Registra a instância como ativa para reuso pela rota manual.
  activeCitoAdapter = citoAdapter;

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
export async function stopAllJobs(citoAdapter: CitoAdapter = activeCitoAdapter): Promise<void> {
  const tasksToStop = scheduledTasks.splice(0, scheduledTasks.length);
  await Promise.allSettled(tasksToStop.map((task) => Promise.resolve(task.stop())));

  citoAdapter.disconnectAll();
  activeCitoMatches.clear();
}
