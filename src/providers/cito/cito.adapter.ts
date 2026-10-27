// =============================================================================
// src/providers/cito/cito.adapter.ts — Adapter de Tempo Real da Cito Sports API
// -----------------------------------------------------------------------------
// O QUE: Recebe o "handoff" das partidas que a PandaScore marcou como AO VIVO,
//        localiza a mesma partida na Cito Sports (`GET /cs2/live`), vincula o
//        ID externo (`cs2-match-XXXX`) ao nosso UUID canônico e passa a consultar
//        `GET /cs2/live/{citoMatchId}/state` em alta frequência. Cada snapshot
//        é traduzido para o modelo canônico `CS2LiveState` e publicado no Redis
//        via `saveAndPublishLiveState` (SET + PUBLISH atômicos em MULTI/EXEC).
//
// [UPDATE]: Substitui o gerador de eventos simulados (FURIA vs Vitality em loop)
//           pela integração HTTP real com a Cito Sports (`https://api.citoapi.com`).
//
// POR QUE ESTA ARQUITETURA:
//   - Divisão de Responsabilidades: PandaScore = calendário "frio" (6h);
//     Cito = dados granulares "quentes" (placar de rounds, bomba, jogadores
//     vivos, economia). Nenhum dado ao vivo vem da PandaScore.
//   - Polling encadeado (`setTimeout`, não `setInterval`): a documentação da
//     Cito para CS2 expõe apenas endpoints REST de estado ao vivo. Encadear o
//     próximo ciclo somente após o término do anterior impede requisições
//     sobrepostas quando a API fica lenta (sem "empilhamento" de chamadas).
//   - Publicação somente quando há mudança (fingerprint): evita inundar o Redis
//     Pub/Sub e os WebSockets dos celulares com snapshots idênticos, economizando
//     bateria e dados móveis.
//   - Backoff exponencial + encerramento automático: protege a franquia da API
//     e garante que sessões de partidas encerradas sejam liberadas da memória.
// =============================================================================
import { env } from '../../config/env.js';
import { db } from '../../core/database.js';
import { saveAndPublishLiveState } from '../../core/live-state.cache.js';
import { MappingService, mappingService } from '../../core/mapping.service.js';
import type { CS2KillEvent, CS2LiveState, CS2Side, MatchFormat, UUID } from '../../core/models.js';

// -----------------------------------------------------------------------------
// Tipos brutos da Cito Sports API (somente os campos que consumimos).
// Formato de resposta padrão: `{ success, data, meta }`.
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

/** Erro HTTP com status, para decidir entre retry (5xx) e abortar (401/403). */
class CitoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const LIVE_LIST_CACHE_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 10;
/** Respostas "não ao vivo" seguidas antes de encerrar (tolera intervalo entre mapas). */
const NOT_LIVE_THRESHOLD = 3;
const KILLFEED_LIMIT = 10;
/** Janela para considerar um evento `BombPlanted` como pertencente ao round atual. */
const BOMB_EVENT_WINDOW_MS = 60_000;

export class CitoAdapter {
  readonly providerId = 'cito' as const;
  private readonly sessions = new Map<UUID, TrackingSession>();
  private liveListCache: { fetchedAt: number; data: Promise<CitoLiveMatchSummary[]> } | null = null;
  private invalidMappingsPurged = false;

  constructor(
    private readonly mapper: MappingService = mappingService,
    private readonly apiKey: string = env.CITO_API_KEY || env.providers.citoApiKey,
    private readonly baseUrl: string = env.CITO_API_BASE_URL,
    private readonly pollIntervalMs: number = env.CITO_POLL_INTERVAL_MS,
  ) {}

  // ---------------------------------------------------------------------------
  // Configuração / autenticação
  // ---------------------------------------------------------------------------

  /** Indica se há uma chave real configurada (sem placeholder `fake_`). */
  isConfigured(): boolean {
    const key = this.apiKey?.trim();
    return Boolean(key) && !key.startsWith('fake_');
  }

  /**
   * Valida a `CITO_API_KEY`. POR QUE lançar erro em vez de simular: dados
   * falsos no placar ao vivo enganariam o usuário; preferimos falhar de forma
   * explícita no log para que a configuração seja corrigida.
   */
  assertValidApiKey(): string {
    if (!this.isConfigured()) {
      const msg =
        '[cito] ERRO CRÍTICO: Variável de ambiente CITO_API_KEY está vazia, indefinida ou utilizando chave fake. Configure uma chave real no arquivo .env.';
      console.error(msg);
      throw new Error(msg);
    }
    return this.apiKey.trim();
  }

  // ---------------------------------------------------------------------------
  // API pública (usada pelo cron.manager)
  // ---------------------------------------------------------------------------

  isTracking(matchId: UUID): boolean {
    return this.sessions.has(matchId);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * HANDOFF PandaScore -> Cito: inicia o monitoramento ao vivo de uma partida.
   * @returns `true` se a partida foi localizada na Cito e o polling começou;
   *          `false` se ela ainda não aparece como ao vivo na Cito (o watchdog
   *          tenta novamente no próximo minuto).
   */
  async startLiveTracking(
    target: LiveTrackingTarget,
    onEnded?: (matchId: UUID) => void,
  ): Promise<boolean> {
    this.assertValidApiKey();

    // Idempotência: nunca cria duas sessões de polling para a mesma partida.
    if (this.sessions.has(target.matchId)) return true;

    await this.purgeInvalidCitoMappings();

    const resolved = await this.resolveCitoMatch(target);
    if (!resolved) return false;

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
      .query(`UPDATE matches SET status = 'live', updated_at = NOW() WHERE id = $1 AND status <> 'live'`, [
        target.matchId,
      ])
      .catch((err: unknown) => console.warn('[cito] Falha ao marcar partida como live no banco:', err));

    console.info(
      `[cito] Handoff concluído: partida ${target.matchId} -> ${resolved.citoMatchId} (polling a cada ${this.pollIntervalMs}ms)`,
    );

    // Primeiro ciclo imediato: hidrata o Redis o quanto antes (latência ~0 no app).
    this.scheduleNextPoll(session, 0);
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
  // HTTP
  // ---------------------------------------------------------------------------

  /** GET autenticado (`x-api-key`) com timeout. Retorna `null` em 404. */
  private async request<T>(path: string): Promise<T | null> {
    const token = this.assertValidApiKey();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json', 'x-api-key': token },
      // Timeout curto: um request travado não pode atrasar o placar ao vivo.
      signal: AbortSignal.timeout(8_000),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CitoHttpError(
        `[cito] HTTP ${response.status} (${response.statusText}) em ${path}: ${body.slice(0, 300)}`,
        response.status,
      );
    }

    const envelope = (await response.json()) as CitoEnvelope<T>;
    return envelope?.data ?? null;
  }

  /**
   * Lista de partidas ao vivo na Cito com cache de 10s compartilhado.
   * POR QUE: o watchdog pode tentar vincular várias partidas no mesmo minuto;
   * uma única requisição serve todas (e também fornece o placar da série).
   */
  private listLiveMatches(): Promise<CitoLiveMatchSummary[]> {
    const now = Date.now();
    if (this.liveListCache && now - this.liveListCache.fetchedAt < LIVE_LIST_CACHE_MS) {
      return this.liveListCache.data;
    }
    const data = this.request<CitoLiveMatchSummary[]>('/cs2/live').then((list) =>
      Array.isArray(list) ? list : [],
    );
    // Em caso de erro, descarta o cache para que a próxima chamada tente de novo.
    data.catch(() => {
      if (this.liveListCache?.data === data) this.liveListCache = null;
    });
    this.liveListCache = { fetchedAt: now, data };
    return data;
  }

  // ---------------------------------------------------------------------------
  // Vínculo PandaScore <-> Cito
  // ---------------------------------------------------------------------------

  /**
   * Remove vínculos `cito` inválidos criados por versões antigas do watchdog
   * (que usavam o próprio UUID interno como "ID externo"). Sem isso, a
   * constraint `provider_mappings_entity_uq` impediria o vínculo correto.
   */
  private async purgeInvalidCitoMappings(): Promise<void> {
    if (this.invalidMappingsPurged) return;
    this.invalidMappingsPurged = true;
    await db
      .query(
        `DELETE FROM provider_mappings
          WHERE provider = 'cito' AND entity_type = 'match' AND external_id NOT LIKE 'cs2-match-%'`,
      )
      .catch((err: unknown) => console.warn('[cito] Falha ao limpar vínculos inválidos:', err));
  }

  /**
   * Descobre o ID da partida na Cito:
   *   1. Vínculo já salvo em `provider_mappings` (caminho rápido).
   *   2. Caso contrário, compara os nomes/siglas dos times com `GET /cs2/live`
   *      e grava o vínculo para as próximas consultas.
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

    const candidates = mappedId ? liveList.filter((m) => m.matchId === mappedId) : liveList;

    for (const summary of candidates) {
      const direct =
        teamMatches(target.teamA, summary.team1Name) && teamMatches(target.teamB, summary.team2Name);
      const inverted =
        teamMatches(target.teamA, summary.team2Name) && teamMatches(target.teamB, summary.team1Name);

      // Com vínculo já salvo, aceitamos mesmo sem casar nomes (ordem padrão).
      if (direct || inverted || mappedId) {
        if (!mappedId) {
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

    return null;
  }

  // ---------------------------------------------------------------------------
  // Loop de polling
  // ---------------------------------------------------------------------------

  private scheduleNextPoll(session: TrackingSession, delayMs: number): void {
    if (session.stopped) return;
    session.timer = setTimeout(() => {
      void this.pollOnce(session);
    }, delayMs);
    // `unref()`: o timer não impede o encerramento do processo Node.
    session.timer.unref();
  }

  /** Um ciclo: busca estado na Cito -> traduz -> publica no Redis se mudou. */
  private async pollOnce(session: TrackingSession): Promise<void> {
    if (session.stopped) return;

    try {
      const raw = await this.request<CitoLiveStateRaw>(
        `/cs2/live/${encodeURIComponent(session.citoMatchId)}/state`,
      );

      // Partida saiu do ar (404 ou status != live). Toleramos alguns ciclos
      // para não encerrar durante a troca de mapas/pausas técnicas.
      if (!raw || raw.status !== 'live') {
        session.consecutiveNotLive += 1;
        if (session.consecutiveNotLive >= NOT_LIVE_THRESHOLD) {
          await this.finishSession(session);
          return;
        }
        this.scheduleNextPoll(session, this.pollIntervalMs * 2);
        return;
      }

      session.consecutiveNotLive = 0;
      session.consecutiveFailures = 0;

      // Placar da série (mapas vencidos) vem da listagem (cache de 10s).
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
        // SET `match:live:{uuid}` + PUBLISH `channel:match:{uuid}` (MULTI/EXEC).
        // O `live.ws.ts` está inscrito neste canal e repassa ao app mobile.
        await saveAndPublishLiveState(session.target.matchId, state);
      }

      this.scheduleNextPoll(session, this.pollIntervalMs);
    } catch (err) {
      session.consecutiveFailures += 1;
      const status = err instanceof CitoHttpError ? err.status : null;
      console.error(
        `[cito] Falha no polling da partida ${session.target.matchId} (tentativa ${session.consecutiveFailures}):`,
        err instanceof Error ? err.message : err,
      );

      // 401/403: chave inválida ou plano sem acesso -> não adianta insistir.
      if (status === 401 || status === 403 || session.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`[cito] Monitoramento da partida ${session.target.matchId} interrompido.`);
        this.endSession(session);
        return;
      }

      // Backoff exponencial (2x, 4x, 8x) para aliviar a API em instabilidades.
      const factor = Math.min(2 ** session.consecutiveFailures, 8);
      this.scheduleNextPoll(session, this.pollIntervalMs * factor);
    }
  }

  /** Publica o snapshot final como `finished`, atualiza o banco e libera a sessão. */
  private async finishSession(session: TrackingSession): Promise<void> {
    const matchId = session.target.matchId;
    console.info(`[cito] Partida ${matchId} encerrada na Cito; finalizando monitoramento.`);

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
      console.warn(`[cito] Falha ao finalizar partida ${matchId}:`, err);
    }

    this.endSession(session);
  }

  private endSession(session: TrackingSession): void {
    const matchId = session.target.matchId;
    this.stopLiveTracking(matchId);
    // Notifica o cron.manager para remover a partida do `activeCitoMatches`.
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
    const mapName = raw.currentMap ?? 'unknown';
    const roundNumber = raw.currentRound ?? 0;

    // Troca de mapa: zera killfeed e contadores (estatísticas são por mapa).
    if (session.currentMapName !== mapName) {
      session.currentMapName = mapName;
      session.previousPlayers.clear();
      session.killfeed = [];
    }

    // Lados: a Cito informa o placar por lado (CT/T); cruzamos com o placar
    // por time para descobrir de qual lado o `team1` está.
    const team1Side = inferTeam1Side(raw);
    const team2Side: CS2Side = team1Side === 'CT' ? 'T' : 'CT';

    const team1 = {
      side: team1Side,
      score: raw.score?.team1 ?? 0,
      mapsWon: summary?.score?.team1 ?? 0,
    };
    const team2 = {
      side: team2Side,
      score: raw.score?.team2 ?? 0,
      mapsWon: summary?.score?.team2 ?? 0,
    };
    // Mantém SEMPRE a ordem `team_a`/`team_b` do nosso banco.
    const a = swapped ? team2 : team1;
    const b = swapped ? team1 : team2;

    const teamIdBySide = (side: string | null): UUID =>
      side === a.side ? (target.teamA.id ?? '') : (target.teamB.id ?? '');

    const sideStats = (side: CS2Side) => {
      const ofSide = players.filter((p) => p.side === side);
      return {
        alive: ofSide.filter((p) => p.alive !== false).length,
        money: ofSide.reduce((sum, p) => sum + (p.money ?? 0), 0),
      };
    };
    const aStats = sideStats(a.side);
    const bStats = sideStats(b.side);

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
          economy: { money: aStats.money, equipmentValue: 0, lossBonusLevel: 0, buyType: null },
        },
        teamB: {
          teamId: target.teamB.id ?? '',
          name: target.teamB.name ?? (swapped ? raw.teams.team1Name : raw.teams.team2Name),
          acronym: target.teamB.acronym,
          side: b.side,
          score: b.score,
          mapsWon: b.mapsWon,
          playersAlive: bStats.alive,
          economy: { money: bStats.money, equipmentValue: 0, lossBonusLevel: 0, buyType: null },
        },
      },
      bomb,
      killfeed: [...session.killfeed],
      sequence: session.sequence,
      updatedAt: now,
      source: this.providerId,
    };
  }

  /**
   * Deriva entradas de killfeed comparando kills/deaths entre dois snapshots.
   * POR QUE: o endpoint de estado da Cito traz estatísticas acumuladas, não
   * eventos individuais. Quando o número de novos abates bate com o número de
   * novas mortes no intervalo, conseguimos parear atacante/vítima com segurança;
   * caso contrário (muitos eventos no mesmo ciclo), descartamos para não exibir
   * um killfeed incorreto.
   */
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
        for (let i = 0; i < killDelta && i < 5; i += 1) attackers.push({ p, headshot: i < hsDelta });
        for (let i = 0; i < deaths - prev.deaths && i < 5; i += 1) victims.push(p);
      }
      session.previousPlayers.set(p.playerId, { kills, deaths, headshots });
    }

    if (attackers.length === 0 || attackers.length !== victims.length) return;

    // Pareia atacantes e vítimas de lados opostos.
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

    // Mantém apenas os N eventos mais recentes (payload enxuto para o mobile).
    session.killfeed.length = Math.min(session.killfeed.length, KILLFEED_LIMIT);
  }

  /** Status da C4: usa `bombPlanted` e o evento de plant mais recente (se recente). */
  private resolveBomb(raw: CitoLiveStateRaw, now: number): CS2LiveState['bomb'] {
    if (!raw.bombPlanted) return { state: 'carried', site: null, plantedAt: null };

    const latestPlant = (raw.liveBombEvents ?? [])
      .filter((e) => e.eventType === 'BombPlanted')
      .map((e) => ({ ...e, ts: Date.parse(e.observedAt) }))
      .filter((e) => Number.isFinite(e.ts) && now - e.ts <= BOMB_EVENT_WINDOW_MS)
      .sort((x, y) => y.ts - x.ts)[0];

    const site = latestPlant?.bombSite === 'A' || latestPlant?.bombSite === 'B' ? latestPlant.bombSite : null;
    return { state: 'planted', site, plantedAt: latestPlant?.ts ?? now };
  }
}

// -----------------------------------------------------------------------------
// Helpers puros
// -----------------------------------------------------------------------------

/** Normaliza nomes para comparação ("Team Spirit" ~ "Spirit", "NAVI" ~ "navi"). */
function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(team|esports?|gaming|clan)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/** Verifica se o nome de um time na Cito corresponde ao nome OU à sigla do nosso time. */
function teamMatches(team: { name: string | null; acronym: string | null }, citoName: string): boolean {
  const target = normalizeTeamName(citoName);
  if (!target) return false;
  for (const candidate of [team.name, team.acronym]) {
    if (!candidate) continue;
    const norm = normalizeTeamName(candidate);
    if (!norm) continue;
    if (norm === target) return true;
    if (norm.length >= 4 && target.length >= 4 && (norm.includes(target) || target.includes(norm))) {
      return true;
    }
  }
  return false;
}

/** Deduz o lado do `team1` cruzando placar por time com placar por lado. */
function inferTeam1Side(raw: CitoLiveStateRaw): CS2Side {
  const { score, currentScoreCt: ct, currentScoreT: t } = raw;
  if (score && ct !== null && t !== null) {
    if (score.team1 === ct && score.team2 === t) return 'CT';
    if (score.team1 === t && score.team2 === ct) return 'T';
  }
  // Sem como inferir com segurança: padrão estável (evita "piscar" de cores na UI).
  return 'CT';
}

/** Impressão digital do snapshot ignorando campos que mudam a cada ciclo. */
function fingerprintOf(state: CS2LiveState): string {
  const { updatedAt: _u, sequence: _s, round, ...rest } = state;
  return JSON.stringify({
    ...rest,
    round: { number: round.number, phase: round.phase, remainingMs: round.clock.remainingMs },
  });
}
