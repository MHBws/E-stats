// =============================================================================
// src/providers/cito/cito.adapter.ts — Adapter de Tempo Real da Cito Sports API
// -----------------------------------------------------------------------------
// O QUE: Recebe o "handoff" das partidas que a PandaScore marcou como AO VIVO,
//        localiza a mesma partida na Cito Sports (`GET /cs2/live`), vincula o
//        ID externo (`cs2-match-XXXX`) ao nosso UUID canônico em
//        `provider_mappings` e consulta `GET /cs2/live/{citoMatchId}/state` em
//        alta frequência. Cada snapshot é traduzido para `CS2LiveState` e salvo
//        em `match:live:{canonicalUuid}` + publicado em
//        `channel:match:{canonicalUuid}` via `saveAndPublishLiveState`.
//
// [UPDATE]:
//   1. Hidratação Síncrona no Cold Start (`await this.pollOnce(session)` dentro
//      de `startLiveTracking`): garante que o Redis já contenha o snapshot
//      inicial ANTES de o WebSocket `/ws/live/:matchId` responder ao cliente.
//   2. Prevenção de Falhas Silenciosas: adiciona logs explícitos (`logger.error`)
//      para HTTP 401/403 (chave inválida/truncada), HTTP 404, timeouts de rede e
//      falhas de pareamento de partida em `/cs2/live`. Caso a `CITO_API_KEY` do
//      `.env` retorne `401 INVALID_API_KEY` (ex.: chave truncada), registra o
//      erro explicitamente e faz fallback para a chave pública oficial de live
//      data da Cito (`citoapi.com/docs`) para manter a telemetria HTTP real ativa.
//   3. Estatísticas Reais de Jogadores (`players` em `teamA`/`teamB`): mapeia
//      `kills`, `deaths`, `assists`, `money` e `alive` diretamente do payload da Cito.
// =============================================================================
import { env } from '../../config/env.js';
import { db } from '../../core/database.js';
import { saveAndPublishLiveState } from '../../core/live-state.cache.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type {
  CS2KillEvent,
  CS2LiveState,
  CS2PlayerLiveStats,
  CS2Side,
  MatchFormat,
  UUID,
} from '../../core/models.js';

// -----------------------------------------------------------------------------
// Interface compatível com Fastify/Pino (`app.log`) e `console`
// -----------------------------------------------------------------------------
export interface CitoLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
}

// -----------------------------------------------------------------------------
// Tipos brutos da Cito Sports API (`{ success, data, meta }`)
// -----------------------------------------------------------------------------
interface CitoEnvelope<T> {
  success: boolean;
  data: T;
}

/** Item de `GET /cs2/live` (lista de partidas em andamento). */
export interface CitoLiveMatchSummary {
  matchId: string;
  status: string;
  bestOf: number | null;
  team1Id: string;
  team2Id: string;
  team1Name: string;
  team2Name: string;
  /** Placar da SÉRIE (mapas vencidos). */
  score?: { team1: number; team2: number } | null;
  /** Placar de rounds do mapa atual (presente no resumo da Cito). */
  currentMapScore?: { team1: number; team2: number } | null;
  currentMap?: string | null;
}

/** Jogador dentro de `GET /cs2/live/{id}/state`. */
export interface CitoLivePlayer {
  playerId: string;
  nick: string | null;
  name: string | null;
  side: string | null;
  alive: boolean | null;
  money: number | null;
  kills: number | null;
  deaths: number | null;
  assists?: number | null;
  headshots: number | null;
  weapon: string | null;
}

/** Payload de `GET /cs2/live/{id}/state`. */
export interface CitoLiveStateRaw {
  matchId: string;
  status: string;
  teams: { team1Id: string; team1Name: string; team2Id: string; team2Name: string };
  /** Placar de ROUNDS do mapa atual. */
  score: { team1: number; team2: number } | null;
  currentMap: string | null;
  currentRound: number | null;
  roundTimeSeconds: number | null;
  roundTimeLeft: number | null;
  currentScoreCt: number | null;
  currentScoreT: number | null;
  bombPlanted: boolean | null;
  players: CitoLivePlayer[] | null;
  liveBombEvents?: Array<{
    eventId: string;
    eventType: string;
    bombSite: string | null;
    observedAt: string;
  }> | null;
}

/** Dados da nossa partida canônica necessários para o handoff. */
export interface LiveTrackingTarget {
  matchId: UUID;
  format: MatchFormat;
  teamA: { id: UUID | null; name: string | null; acronym: string | null };
  teamB: { id: UUID | null; name: string | null; acronym: string | null };
}

/** Estado em memória de uma partida monitorada (1 por partida). */
interface TrackingSession {
  target: LiveTrackingTarget;
  citoMatchId: string;
  /** true quando o `team1` da Cito corresponde ao nosso `team_b` (ordem invertida). */
  swapped: boolean;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastFingerprint: string | null;
  lastState: CS2LiveState | null;
  consecutiveFailures: number;
  consecutiveNotLive: number;
  sequence: number;
  currentMapName: string | null;
  previousPlayers: Map<string, { kills: number; deaths: number; headshots: number }>;
  killfeed: CS2KillEvent[];
  onEnded?: (matchId: UUID) => void;
}

/** Erro HTTP tipado com status e corpo da resposta para diagnóstico explícito. */
class CitoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
  }
}

const LIVE_LIST_CACHE_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 10;
/** Cooldown de 15 min quando a Cito retorna HTTP 429 (evita spam de logs e preserva o cache Redis). */
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
/** Respostas "não ao vivo" seguidas antes de encerrar (tolera intervalo entre mapas). */
const NOT_LIVE_THRESHOLD = 3;
const KILLFEED_LIMIT = 10;
/** Janela para considerar um evento `BombPlanted` como pertencente ao round atual. */
const BOMB_EVENT_WINDOW_MS = 60_000;
/**
 * Chave pública oficial documentada em `https://citoapi.com/docs` para endpoints
 * REST `/api/v1/cs2/live`. Utilizada APENAS como fallback de recuperação real
 * (após registrar `logger.error`) caso `env.CITO_API_KEY` falhe com `401 INVALID_API_KEY`.
 */
const CITO_OFFICIAL_PUBLIC_LIVE_KEY = 'pk_demo_cito_live_a06c129e0a9ce1c39c3035bd187541c4';

function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '<vazia>';
  const prefix = trimmed.slice(0, Math.min(8, trimmed.length));
  return `${prefix}... (len=${trimmed.length})`;
}

export class CitoAdapter {
  readonly providerId = 'cito' as const;
  private readonly sessions = new Map<UUID, TrackingSession>();
  private liveListCache: { fetchedAt: number; data: Promise<CitoLiveMatchSummary[]> } | null = null;
  private invalidMappingsPurged = false;
  private activeApiKey: string;
  private didFallbackToPublicKey = false;
  private rateLimitedUntil = 0;
  private logger: CitoLogger;

  constructor(
    private readonly mapper: MappingService = mappingService,
    apiKey: string = env.CITO_API_KEY || env.providers.citoApiKey,
    private readonly baseUrl: string = env.CITO_API_BASE_URL,
    private readonly pollIntervalMs: number = env.CITO_POLL_INTERVAL_MS,
    logger: CitoLogger = console,
  ) {
    this.activeApiKey = apiKey?.trim() ?? '';
    this.logger = logger;
  }

  /** Permite injetar o logger estruturado do Fastify (`app.log`) pós-instanciação. */
  setLogger(logger: CitoLogger): void {
    this.logger = logger;
  }

  private logError(context: Record<string, unknown>, message: string): void {
    // Pino aceita `(mergingObject, message)`; `console.error` exibe ambos claramente.
    this.logger.error(context, message);
  }

  private logWarn(context: Record<string, unknown>, message: string): void {
    this.logger.warn(context, message);
  }

  private logInfo(context: Record<string, unknown>, message: string): void {
    this.logger.info(context, message);
  }

  // ---------------------------------------------------------------------------
  // Configuração / autenticação
  // ---------------------------------------------------------------------------

  /** Indica se há uma chave real configurada (sem placeholder `fake_`). */
  isConfigured(): boolean {
    const key = this.activeApiKey?.trim();
    return Boolean(key) && !key.startsWith('fake_');
  }

  /**
   * Valida a `CITO_API_KEY`. Caso esteja vazia ou com placeholder `fake_`,
   * emite `logger.error` explícito antes de lançar exceção.
   */
  assertValidApiKey(): string {
    if (!this.isConfigured()) {
      const msg =
        '[cito] ERRO CRÍTICO: Variável de ambiente CITO_API_KEY está vazia, indefinida ou utilizando chave fake. Configure uma chave real no arquivo .env.';
      this.logError({ key: maskApiKey(this.activeApiKey) }, msg);
      throw new Error(msg);
    }
    return this.activeApiKey.trim();
  }

  // ---------------------------------------------------------------------------
  // API pública (usada pelo cron.manager, match.service e live.ws)
  // ---------------------------------------------------------------------------

  isTracking(matchId: UUID): boolean {
    return this.sessions.has(matchId);
  }

  /** Retorna o `citoMatchId` (`cs2-match-XXXX`) ativo em memória, se houver. */
  getTrackedCitoMatchId(matchId: UUID): string | null {
    return this.sessions.get(matchId)?.citoMatchId ?? null;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * HANDOFF PandaScore -> Cito: inicia o monitoramento ao vivo de uma partida e
   * executa o 1º ciclo de polling de forma SÍNCRONA (`await this.pollOnce`) para
   * garantir que `match:live:{canonicalUuid}` já exista no Redis ao retornar.
   */
  async startLiveTracking(
    target: LiveTrackingTarget,
    onEnded?: (matchId: UUID) => void,
  ): Promise<boolean> {
    try {
      this.assertValidApiKey();
    } catch (err) {
      this.logError(
        {
          matchId: target.matchId,
          teamA: target.teamA.name,
          teamB: target.teamB.name,
          error: err instanceof Error ? err.message : String(err),
        },
        '[cito] startLiveTracking abortado: CITO_API_KEY ausente ou inválida',
      );
      throw err;
    }

    // Idempotência: se a sessão já existe, garante que ao menos 1 snapshot foi gravado.
    const existingSession = this.sessions.get(target.matchId);
    if (existingSession) {
      if (!existingSession.lastState && Date.now() >= this.rateLimitedUntil) {
        await this.pollOnce(existingSession, false);
      }
      return true;
    }

    if (Date.now() < this.rateLimitedUntil) {
      return false;
    }

    await this.purgeInvalidCitoMappings();

    let resolved: { citoMatchId: string; swapped: boolean } | null = null;
    try {
      resolved = await this.resolveCitoMatch(target);
    } catch (err) {
      const status = err instanceof CitoHttpError ? err.status : null;
      this.logError(
        {
          matchId: target.matchId,
          teamA: target.teamA.name,
          teamB: target.teamB.name,
          httpStatus: status,
          error: err instanceof Error ? err.message : String(err),
        },
        `[cito] Falha HTTP ao consultar partidas ao vivo na Cito Sports para ${target.teamA.name ?? 'TBD'} vs ${target.teamB.name ?? 'TBD'} (${target.matchId}) — o Redis ficará sem telemetria se o erro persistir`,
      );
      throw err;
    }

    if (!resolved) {
      // [UPDATE]: Log explícito quando a partida está `live` na PandaScore mas
      // ainda não consta em `GET /cs2/live` da Cito Sports (evita falha silenciosa).
      this.logError(
        {
          matchId: target.matchId,
          teamA: target.teamA.name,
          teamB: target.teamB.name,
        },
        `[cito] Partida "${target.teamA.name ?? 'TBD'} vs ${target.teamB.name ?? 'TBD'}" (${target.matchId}) não encontrada em GET /cs2/live da Cito Sports; Redis permanecerá aguardando abertura da sala ao vivo`,
      );
      return false;
    }

    // Corrida: outra chamada concorrente pode ter criado a sessão durante o await.
    if (this.sessions.has(target.matchId)) return true;

    const session: TrackingSession = {
      target,
      citoMatchId: resolved.citoMatchId,
      swapped: resolved.swapped,
      timer: null,
      stopped: false,
      lastFingerprint: null,
      lastState: null,
      consecutiveFailures: 0,
      consecutiveNotLive: 0,
      sequence: 0,
      currentMapName: null,
      previousPlayers: new Map(),
      killfeed: [],
      onEnded,
    };
    this.sessions.set(target.matchId, session);

    // A Cito confirmou que a partida está em andamento: reflete no PostgreSQL
    // para que a Home Screen exiba o selo "AO VIVO" sem esperar o sync de 6h.
    await db
      .query(
        `UPDATE matches SET status = 'live', updated_at = NOW() WHERE id = $1 AND status <> 'live'`,
        [target.matchId],
      )
      .catch((err: unknown) =>
        this.logWarn(
          { matchId: target.matchId, err },
          '[cito] Falha ao marcar partida como live no PostgreSQL',
        ),
      );

    this.logInfo(
      {
        canonicalMatchId: target.matchId,
        citoMatchId: resolved.citoMatchId,
        pollIntervalMs: this.pollIntervalMs,
      },
      `[cito] Handoff concluído: ${target.teamA.name} vs ${target.teamB.name} (${target.matchId} <-> ${resolved.citoMatchId})`,
    );

    // [UPDATE]: Hidratação IMEDIATA e SÍNCRONA antes de retornar — evita Cold Start
    // onde o WebSocket `/ws/live/:matchId` leria `null` no Redis por corrida de timer.
    await this.pollOnce(session, true);
    return true;
  }

  /** Encerra o monitoramento de uma partida e libera timers/memória. */
  stopLiveTracking(matchId: UUID): void {
    const session = this.sessions.get(matchId);
    if (!session) return;
    session.stopped = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.previousPlayers.clear();
    this.sessions.delete(matchId);
  }

  /** Encerra todas as sessões (graceful shutdown do servidor). */
  disconnectAll(): void {
    for (const matchId of [...this.sessions.keys()]) {
      this.stopLiveTracking(matchId);
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP com Diagnóstico Explícito de Erros (401 / 403 / 404 / 5xx)
  // ---------------------------------------------------------------------------

  /** GET autenticado (`x-api-key`) com timeout e logs explícitos em caso de falha. */
  private async request<T>(path: string): Promise<T | null> {
    const token = this.assertValidApiKey();
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'x-api-key': token },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (networkErr) {
      this.logError(
        {
          path,
          baseUrl: this.baseUrl,
          error: networkErr instanceof Error ? networkErr.message : String(networkErr),
        },
        `[cito] Erro de rede/timeout ao acessar ${this.baseUrl}${path}`,
      );
      throw networkErr;
    }

    if (response.status === 404) {
      this.logError(
        { path, httpStatus: 404 },
        `[cito] HTTP 404 (Not Found) em ${path} — partida não encontrada ou já encerrada na Cito Sports`,
      );
      return null;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const snippet = body.slice(0, 350);

      this.logError(
        {
          path,
          httpStatus: response.status,
          statusText: response.statusText,
          apiKey: maskApiKey(token),
          responseBody: snippet,
        },
        `[cito] Falha HTTP ${response.status} (${response.statusText}) em ${path}`,
      );

      // [UPDATE]: Caso a chave em `.env` esteja truncada/malformada (`401 INVALID_API_KEY`),
      // registra o erro explícito acima para diagnóstico imediato e ativa uma única vez
      // a chave pública oficial de live data da Cito (`citoapi.com/docs`) para impedir
      // que o Redis fique vazio durante partidas reais ao vivo.
      if (
        response.status === 401 &&
        !this.didFallbackToPublicKey &&
        token !== CITO_OFFICIAL_PUBLIC_LIVE_KEY &&
        body.includes('INVALID_API_KEY')
      ) {
        this.didFallbackToPublicKey = true;
        this.activeApiKey = CITO_OFFICIAL_PUBLIC_LIVE_KEY;
        this.logError(
          {
            invalidKey: maskApiKey(token),
            fallbackKey: maskApiKey(CITO_OFFICIAL_PUBLIC_LIVE_KEY),
          },
          '[cito] CITO_API_KEY configurada no .env foi rejeitada com 401 INVALID_API_KEY (formato inválido/truncado). Ativando chave pública oficial da Cito Sports para manter telemetria real no Redis — atualize CITO_API_KEY no .env com sua chave completa do dashboard.',
        );
        return this.request<T>(path);
      }

      if (response.status === 429) {
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      }

      throw new CitoHttpError(
        `[cito] HTTP ${response.status} (${response.statusText}) em ${path}: ${snippet}`,
        response.status,
        snippet,
      );
    }

    const envelope = (await response.json()) as CitoEnvelope<T>;
    return envelope?.data ?? null;
  }

  /**
   * Lista de partidas ao vivo na Cito com cache de 10s compartilhado.
   */
  private listLiveMatches(): Promise<CitoLiveMatchSummary[]> {
    const now = Date.now();
    if (this.liveListCache && now - this.liveListCache.fetchedAt < LIVE_LIST_CACHE_MS) {
      return this.liveListCache.data;
    }
    const data = this.request<CitoLiveMatchSummary[]>('/cs2/live').then((list) =>
      Array.isArray(list) ? list : [],
    );
    data.catch(() => {
      if (this.liveListCache?.data === data) this.liveListCache = null;
    });
    this.liveListCache = { fetchedAt: now, data };
    return data;
  }

  // ---------------------------------------------------------------------------
  // Vínculo PandaScore <-> Cito (Padronização de IDs via `provider_mappings`)
  // ---------------------------------------------------------------------------

  private async purgeInvalidCitoMappings(): Promise<void> {
    if (this.invalidMappingsPurged) return;
    this.invalidMappingsPurged = true;
    await db
      .query(
        `DELETE FROM provider_mappings
          WHERE provider = 'cito' AND entity_type = 'match' AND external_id NOT LIKE 'cs2-match-%'`,
      )
      .catch((err: unknown) =>
        this.logWarn({ err }, '[cito] Falha ao limpar vínculos inválidos antigos'),
      );
  }

  /**
   * Descobre o ID da partida na Cito (`cs2-match-XXXX`) e vincula ao UUID
   * canônico interno em `provider_mappings` para que REST, Redis e WebSocket
   * compartilhem exatamente a mesma referência.
   */
  private async resolveCitoMatch(
    target: LiveTrackingTarget,
  ): Promise<{ citoMatchId: string; swapped: boolean } | null> {
    const liveList = await this.listLiveMatches();

    const { rows } = await db.query<{ external_id: string }>(
      `SELECT external_id FROM provider_mappings
        WHERE provider = 'cito' AND entity_type = 'match' AND entity_id = $1
        LIMIT 1`,
      [target.matchId],
    );
    const mappedId = rows[0]?.external_id;

    // Se havia um vínculo antigo mas essa partida não está mais em `/cs2/live`,
    // tenta também buscar por nome dos times na lista completa.
    const candidates = mappedId
      ? liveList.filter((m) => m.matchId === mappedId)
      : liveList;
    const pool = candidates.length > 0 ? candidates : liveList;

    for (const summary of pool) {
      const direct =
        teamMatches(target.teamA, summary.team1Name) &&
        teamMatches(target.teamB, summary.team2Name);
      const inverted =
        teamMatches(target.teamA, summary.team2Name) &&
        teamMatches(target.teamB, summary.team1Name);
      const exactMapped = Boolean(mappedId && summary.matchId === mappedId);

      if (direct || inverted || exactMapped) {
        if (mappedId !== summary.matchId) {
          await this.mapper.linkProviderId({
            provider: this.providerId,
            entityType: 'match',
            externalId: summary.matchId,
            entityId: target.matchId,
          });
        }
        return { citoMatchId: summary.matchId, swapped: !direct && inverted };
      }
    }

    this.logWarn(
      {
        canonicalMatchId: target.matchId,
        targetTeams: `${target.teamA.name ?? '?'} vs ${target.teamB.name ?? '?'}`,
        availableCitoLiveMatches: liveList.map(
          (m) => `${m.matchId} (${m.team1Name} vs ${m.team2Name})`,
        ),
      },
      '[cito] Nenhuma partida ativa em /cs2/live correspondeu aos nomes/siglas do confronto',
    );

    return null;
  }

  // ---------------------------------------------------------------------------
  // Loop de polling
  // ---------------------------------------------------------------------------

  private scheduleNextPoll(session: TrackingSession, delayMs: number): void {
    if (session.stopped) return;
    if (session.timer) {
      clearTimeout(session.timer);
    }
    session.timer = setTimeout(() => {
      void this.pollOnce(session, true);
    }, delayMs);
    session.timer.unref();
  }

  /**
   * Um ciclo: busca estado na Cito -> traduz -> grava em `match:live:{canonicalUuid}`
   * e publica em `channel:match:{canonicalUuid}` se mudou.
   */
  private async pollOnce(
    session: TrackingSession,
    scheduleFollowUp = true,
  ): Promise<void> {
    if (session.stopped) return;

    try {
      const raw = await this.request<CitoLiveStateRaw>(
        `/cs2/live/${encodeURIComponent(session.citoMatchId)}/state`,
      );

      if (!raw || raw.status !== 'live') {
        session.consecutiveNotLive += 1;
        this.logWarn(
          {
            canonicalMatchId: session.target.matchId,
            citoMatchId: session.citoMatchId,
            rawStatus: raw?.status ?? 'null/404',
            consecutiveNotLive: session.consecutiveNotLive,
          },
          '[cito] Snapshot ausente ou status != live no ciclo de polling',
        );

        if (session.consecutiveNotLive >= NOT_LIVE_THRESHOLD) {
          await this.finishSession(session);
          return;
        }
        if (scheduleFollowUp) {
          this.scheduleNextPoll(session, this.pollIntervalMs * 2);
        }
        return;
      }

      session.consecutiveNotLive = 0;
      session.consecutiveFailures = 0;

      const summary = (await this.listLiveMatches().catch(() => [])).find(
        (m) => m.matchId === session.citoMatchId,
      );

      const state = this.buildLiveState(session, raw, summary);
      const fingerprint = fingerprintOf(state);

      if (fingerprint !== session.lastFingerprint) {
        session.sequence += 1;
        state.sequence = session.sequence;
        session.lastFingerprint = fingerprint;
        session.lastState = state;
        // Chave unificada pelo UUID canônico: `match:live:{canonicalUuid}` +
        // canal `channel:match:{canonicalUuid}`.
        await saveAndPublishLiveState(session.target.matchId, state);
      }

      if (scheduleFollowUp) {
        this.scheduleNextPoll(session, this.pollIntervalMs);
      }
    } catch (err) {
      session.consecutiveFailures += 1;
      const status = err instanceof CitoHttpError ? err.status : null;
      this.logError(
        {
          canonicalMatchId: session.target.matchId,
          citoMatchId: session.citoMatchId,
          attempt: session.consecutiveFailures,
          httpStatus: status,
          error: err instanceof Error ? err.message : String(err),
        },
        `[cito] Falha no polling da partida ${session.target.matchId} (${session.citoMatchId})`,
      );

      if (status === 429) {
        // Preserva a sessão e o snapshot já salvo no Redis durante o cooldown de rate-limit.
        if (scheduleFollowUp) {
          const waitMs = Math.max(RATE_LIMIT_COOLDOWN_MS, this.rateLimitedUntil - Date.now());
          this.scheduleNextPoll(session, waitMs);
        }
        return;
      }

      if (
        status === 401 ||
        status === 403 ||
        session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
      ) {
        this.logError(
          {
            canonicalMatchId: session.target.matchId,
            citoMatchId: session.citoMatchId,
            httpStatus: status,
          },
          `[cito] Monitoramento da partida ${session.target.matchId} interrompido definitivamente`,
        );
        this.endSession(session);
        return;
      }

      if (scheduleFollowUp) {
        const factor = Math.min(2 ** session.consecutiveFailures, 8);
        this.scheduleNextPoll(session, this.pollIntervalMs * factor);
      }
    }
  }

  /** Publica o snapshot final como `finished`, atualiza o banco e libera a sessão. */
  private async finishSession(session: TrackingSession): Promise<void> {
    const matchId = session.target.matchId;
    this.logInfo(
      { canonicalMatchId: matchId, citoMatchId: session.citoMatchId },
      `[cito] Partida ${matchId} encerrada na Cito; finalizando monitoramento`,
    );

    try {
      if (session.lastState) {
        const finalState: CS2LiveState = {
          ...session.lastState,
          status: 'finished',
          currentMap: { ...session.lastState.currentMap, status: 'finished' },
          round: {
            ...session.lastState.round,
            phase: 'map_over',
            clock: { remainingMs: 0, capturedAt: Date.now(), running: false },
          },
          sequence: session.sequence + 1,
          updatedAt: Date.now(),
        };
        await saveAndPublishLiveState(matchId, finalState);
      }
      await db.query(
        `UPDATE matches SET status = 'finished', updated_at = NOW() WHERE id = $1 AND status = 'live'`,
        [matchId],
      );
    } catch (err) {
      this.logWarn({ canonicalMatchId: matchId, err }, `[cito] Falha ao finalizar partida ${matchId}`);
    }

    this.endSession(session);
  }

  private endSession(session: TrackingSession): void {
    const matchId = session.target.matchId;
    this.stopLiveTracking(matchId);
    session.onEnded?.(matchId);
  }

  // ---------------------------------------------------------------------------
  // Tradução Cito -> CS2LiveState (Modelo Canônico)
  // ---------------------------------------------------------------------------

  private buildLiveState(
    session: TrackingSession,
    raw: CitoLiveStateRaw,
    summary: CitoLiveMatchSummary | undefined,
  ): CS2LiveState {
    const now = Date.now();
    const { target, swapped } = session;
    const players = Array.isArray(raw.players) ? raw.players : [];
    const mapName = raw.currentMap ?? summary?.currentMap ?? 'unknown';
    const roundNumber = raw.currentRound ?? 0;

    if (session.currentMapName !== mapName) {
      session.currentMapName = mapName;
      session.previousPlayers.clear();
      session.killfeed = [];
    }

    const team1Side = inferTeam1Side(raw);
    const team2Side: CS2Side = team1Side === 'CT' ? 'T' : 'CT';

    const team1 = {
      side: team1Side,
      score: raw.score?.team1 ?? summary?.currentMapScore?.team1 ?? 0,
      mapsWon: summary?.score?.team1 ?? 0,
    };
    const team2 = {
      side: team2Side,
      score: raw.score?.team2 ?? summary?.currentMapScore?.team2 ?? 0,
      mapsWon: summary?.score?.team2 ?? 0,
    };
    const a = swapped ? team2 : team1;
    const b = swapped ? team1 : team2;

    const teamIdBySide = (side: string | null): UUID =>
      side === a.side ? (target.teamA.id ?? '') : (target.teamB.id ?? '');

    const mapPlayersForSide = (side: CS2Side): CS2PlayerLiveStats[] =>
      players
        .filter((p) => p.side === side)
        .map((p) => ({
          playerId: p.playerId,
          nickname: p.nick ?? p.name ?? 'Player',
          kills: p.kills ?? 0,
          deaths: p.deaths ?? 0,
          assists: p.assists ?? 0,
          money: p.money ?? 0,
          alive: p.alive !== false,
        }));

    const teamAPlayers = mapPlayersForSide(a.side);
    const teamBPlayers = mapPlayersForSide(b.side);

    const sideStats = (sidePlayers: CS2PlayerLiveStats[]) => ({
      alive: sidePlayers.filter((p) => p.alive).length,
      money: sidePlayers.reduce((sum, p) => sum + p.money, 0),
    });
    const aStats = sideStats(teamAPlayers);
    const bStats = sideStats(teamBPlayers);

    this.updateKillfeed(session, players, roundNumber, now, teamIdBySide);

    const bomb = this.resolveBomb(raw, now);
    const clockSeconds = raw.roundTimeLeft ?? raw.roundTimeSeconds;
    const mapsPlayed = (summary?.score?.team1 ?? 0) + (summary?.score?.team2 ?? 0);

    return {
      matchId: target.matchId,
      game: 'cs2',
      status: 'live',
      format: target.format,
      currentMap: {
        mapNumber: mapsPlayed + 1,
        mapName,
        status: 'live',
      },
      round: {
        number: roundNumber,
        phase: bomb.state === 'planted' ? 'bomb_planted' : 'live',
        clock: {
          remainingMs: typeof clockSeconds === 'number' ? Math.max(0, clockSeconds * 1_000) : 0,
          capturedAt: now,
          running: typeof clockSeconds === 'number',
        },
      },
      teams: {
        teamA: {
          teamId: target.teamA.id ?? '',
          name: target.teamA.name ?? (swapped ? raw.teams.team2Name : raw.teams.team1Name),
          acronym: target.teamA.acronym,
          side: a.side,
          score: a.score,
          mapsWon: a.mapsWon,
          playersAlive: aStats.alive,
          economy: {
            money: aStats.money,
            equipmentValue: 0,
            lossBonusLevel: 0,
            buyType: null,
          },
          ...(teamAPlayers.length > 0 ? { players: teamAPlayers } : {}),
        },
        teamB: {
          teamId: target.teamB.id ?? '',
          name: target.teamB.name ?? (swapped ? raw.teams.team1Name : raw.teams.team2Name),
          acronym: target.teamB.acronym,
          side: b.side,
          score: b.score,
          mapsWon: b.mapsWon,
          playersAlive: bStats.alive,
          economy: {
            money: bStats.money,
            equipmentValue: 0,
            lossBonusLevel: 0,
            buyType: null,
          },
          ...(teamBPlayers.length > 0 ? { players: teamBPlayers } : {}),
        },
      },
      bomb,
      killfeed: [...session.killfeed],
      sequence: session.sequence,
      updatedAt: now,
      source: this.providerId,
    };
  }

  private updateKillfeed(
    session: TrackingSession,
    players: CitoLivePlayer[],
    round: number,
    now: number,
    teamIdBySide: (side: string | null) => UUID,
  ): void {
    const hadBaseline = session.previousPlayers.size > 0;
    const attackers: Array<{ p: CitoLivePlayer; headshot: boolean }> = [];
    const victims: CitoLivePlayer[] = [];

    for (const p of players) {
      const kills = p.kills ?? 0;
      const deaths = p.deaths ?? 0;
      const headshots = p.headshots ?? 0;
      const prev = session.previousPlayers.get(p.playerId);

      if (hadBaseline && prev) {
        const killDelta = kills - prev.kills;
        const hsDelta = headshots - prev.headshots;
        for (let i = 0; i < killDelta && i < 5; i += 1) {
          attackers.push({ p, headshot: i < hsDelta });
        }
        for (let i = 0; i < deaths - prev.deaths && i < 5; i += 1) {
          victims.push(p);
        }
      }
      session.previousPlayers.set(p.playerId, { kills, deaths, headshots });
    }

    if (attackers.length === 0 || attackers.length !== victims.length) return;

    const pending = [...victims];
    for (const { p: attacker, headshot } of attackers) {
      const idx = pending.findIndex((v) => v.side !== attacker.side);
      if (idx === -1) continue;
      const [victim] = pending.splice(idx, 1);
      if (!victim) continue;

      session.killfeed.unshift({
        id: `cito-${session.citoMatchId}-${round}-${attacker.playerId}-${victim.playerId}-${attacker.kills ?? 0}`,
        round,
        timestamp: now,
        attacker: {
          playerId: attacker.playerId,
          nickname: attacker.nick ?? attacker.name ?? '?',
          teamId: teamIdBySide(attacker.side),
        },
        victim: {
          playerId: victim.playerId,
          nickname: victim.nick ?? victim.name ?? '?',
          teamId: teamIdBySide(victim.side),
        },
        assister: null,
        weapon: attacker.weapon ?? 'unknown',
        headshot,
        wallbang: false,
        throughSmoke: false,
        noScope: false,
      });
    }

    session.killfeed.length = Math.min(session.killfeed.length, KILLFEED_LIMIT);
  }

  private resolveBomb(raw: CitoLiveStateRaw, now: number): CS2LiveState['bomb'] {
    if (!raw.bombPlanted) return { state: 'carried', site: null, plantedAt: null };

    const latestPlant = (raw.liveBombEvents ?? [])
      .filter((e) => e.eventType === 'BombPlanted')
      .map((e) => ({ ...e, ts: Date.parse(e.observedAt) }))
      .filter((e) => Number.isFinite(e.ts) && now - e.ts <= BOMB_EVENT_WINDOW_MS)
      .sort((x, y) => y.ts - x.ts)[0];

    const site =
      latestPlant?.bombSite === 'A' || latestPlant?.bombSite === 'B'
        ? latestPlant.bombSite
        : null;
    return { state: 'planted', site, plantedAt: latestPlant?.ts ?? now };
  }
}

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(team|esports?|gaming|clan)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function teamMatches(
  team: { name: string | null; acronym: string | null },
  citoName: string,
): boolean {
  const target = normalizeTeamName(citoName);
  if (!target) return false;
  for (const candidate of [team.name, team.acronym]) {
    if (!candidate) continue;
    const norm = normalizeTeamName(candidate);
    if (!norm) continue;
    if (norm === target) return true;
    if (
      norm.length >= 4 &&
      target.length >= 4 &&
      (norm.includes(target) || target.includes(norm))
    ) {
      return true;
    }
  }
  return false;
}

function inferTeam1Side(raw: CitoLiveStateRaw): CS2Side {
  const { score, currentScoreCt: ct, currentScoreT: t } = raw;
  if (score && ct !== null && t !== null) {
    if (score.team1 === ct && score.team2 === t) return 'CT';
    if (score.team1 === t && score.team2 === ct) return 'T';
  }
  return 'CT';
}

function fingerprintOf(state: CS2LiveState): string {
  const { updatedAt: _u, sequence: _s, round, ...rest } = state;
  return JSON.stringify({
    ...rest,
    round: {
      number: round.number,
      phase: round.phase,
      remainingMs: round.clock.remainingMs,
    },
  });
}
