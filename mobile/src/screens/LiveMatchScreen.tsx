// =============================================================================
// mobile/src/screens/LiveMatchScreen.tsx — Detalhes da Partida (Pré / Live / Pós)
// -----------------------------------------------------------------------------
// O QUE: Tela de detalhes de partida que busca os metadados reais via REST
//        (`fetchMatchById(matchId)`) e realiza a renderização condicional
//        completa conforme o `status` real do confronto:
//          1. `status === 'scheduled' | 'not_started'`: Renderiza `<PreMatchStats />`
//             com contador regressivo e elencos (Rosters) reais lado a lado.
//          2. `status === 'live'`: Instancia o WebSocket (`useLiveMatch(matchId)`)
//             e renderiza `<LiveScoreboard />` (relógio, C4 e K/D/A + Bank).
//          3. `status === 'finished'`: Renderiza `<PostMatchSummary />` com o
//             placar final consolidado, parciais por mapa e tabela de Rating/KDA.
//
// POR QUE (Limpeza de Mocks & Eficiência de Rede):
//   - Nenhum dado estático da FURIA/Vitality é utilizado.
//   - O WebSocket só é aberto quando `match.status === 'live'`, poupando bateria
//     no dispositivo móvel e conexões Pub/Sub no servidor para jogos futuros ou
//     já encerrados.
// =============================================================================
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { fetchMatchById } from '../api/apiClient';
import { PostMatchSummary } from '../components/PostMatchSummary';
import { PreMatchStats } from '../components/PreMatchStats';
import { useLiveMatch } from '../hooks/useLiveMatch';
import type {
  CS2BombStatus,
  CS2LiveState,
  CS2PlayerLiveStats,
  CS2Side,
  CS2TeamLiveState,
  MatchDetailDto,
  RootStackParamList,
} from '../types/match';

export type LiveMatchScreenProps = NativeStackScreenProps<RootStackParamList, 'LiveMatch'>;

// Paleta de cores oficial Dark Mode OLED + Lados CS2 (CT Azul / TR Amarelo-Laranja).
const COLORS = {
  background: '#000000',
  card: '#1C1C1E',
  cardBorder: '#2C2C2E',
  textPrimary: '#FFFFFF',
  textSecondary: '#8E8E93',
  ctAccent: '#0A84FF',
  ctSubtleBg: 'rgba(10, 132, 255, 0.14)',
  ctSubtleBorder: 'rgba(10, 132, 255, 0.42)',
  trAccent: '#FF9F0A',
  trSubtleBg: 'rgba(255, 159, 10, 0.14)',
  trSubtleBorder: 'rgba(255, 159, 10, 0.42)',
  danger: '#FF453A',
  success: '#30D158',
} as const;

/** Formata milissegundos (`round_time_remaining_ms`) para `MM:SS`. */
function formatRoundClock(ms: number): string {
  const clampedSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(clampedSeconds / 60);
  const seconds = clampedSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Traduz o estado da C4 para um rótulo legível e cor de destaque na UI. */
function getBombDisplay(bomb: CS2BombStatus): { label: string; color: string } {
  switch (bomb.state) {
    case 'planted':
      return {
        label: `BOMBA PLANTADA${bomb.site ? ` (SITE ${bomb.site})` : ''}`,
        color: COLORS.danger,
      };
    case 'defusing':
      return {
        label: `DESARMANDO C4${bomb.site ? ` (SITE ${bomb.site})` : ''}`,
        color: COLORS.ctAccent,
      };
    case 'defused':
      return { label: 'BOMBA DESARMADA (DEFUSED)', color: COLORS.success };
    case 'exploded':
      return { label: 'BOMBA DETONADA', color: COLORS.trAccent };
    case 'dropped':
      return { label: 'C4 CAÍDA NO CHÃO', color: COLORS.textSecondary };
    case 'carried':
    default:
      return { label: 'C4 EM POSSE DO TR', color: COLORS.textSecondary };
  }
}

/**
 * [UPDATE]: Extrai a lista de jogadores do time a partir de `team.players` ou
 * do roster real retornado pelo endpoint REST (`rosterNicknames`), sem mocks fixos.
 */
function resolveTeamPlayers(
  team: CS2TeamLiveState,
  liveState: CS2LiveState,
  rosterNicknames: string[],
): CS2PlayerLiveStats[] {
  if (team.players && team.players.length > 0) {
    return team.players;
  }

  const perPlayerBank = Math.round((team.economy.money ?? 0) / 5 / 50) * 50;

  return rosterNicknames.map((nickname, idx) => {
    const killsInFeed = liveState.killfeed.filter(
      (k) => k.attacker?.nickname.toLowerCase() === nickname.toLowerCase(),
    ).length;
    const deathsInFeed = liveState.killfeed.filter(
      (k) => k.victim.nickname.toLowerCase() === nickname.toLowerCase(),
    ).length;

    return {
      playerId: `${team.teamId}-p${idx + 1}`,
      nickname,
      kills: killsInFeed,
      deaths: deathsInFeed,
      assists: 0,
      money: perPlayerBank,
      alive: idx < team.playersAlive,
    };
  });
}

// =============================================================================
// Subcomponente `<LiveScoreboard />` — Renderizado apenas quando `status === 'live'`
// =============================================================================
interface ScoreboardHeaderProps {
  teamA: CS2TeamLiveState;
  teamB: CS2TeamLiveState;
  mapName: string;
  roundNumber: number;
  format: string;
}

const ScoreboardHeader = memo(function ScoreboardHeader({
  teamA,
  teamB,
  mapName,
  roundNumber,
  format,
}: ScoreboardHeaderProps): React.JSX.Element {
  const isTeamACT = teamA.side === 'CT';
  const isTeamBCT = teamB.side === 'CT';

  return (
    <View style={styles.scoreboardCard}>
      <View style={styles.mapHeaderRow}>
        <Text style={styles.mapNameText}>{mapName.replace('de_', '').toUpperCase()}</Text>
        <Text style={styles.roundBadgeText}>
          ROUND {roundNumber} · {format}
        </Text>
      </View>

      <View style={styles.scoreboardMainRow}>
        <View
          style={[
            styles.teamHeaderBox,
            isTeamACT ? styles.teamBoxCT : styles.teamBoxTR,
          ]}
        >
          <View
            style={[
              styles.sidePill,
              { backgroundColor: isTeamACT ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            <Text style={styles.sidePillText}>{isTeamACT ? 'CT' : 'TR'}</Text>
          </View>
          <Text style={styles.teamHeaderAcronym} numberOfLines={1}>
            {teamA.acronym ?? teamA.name}
          </Text>
          <Text style={styles.teamHeaderName} numberOfLines={1}>
            {teamA.name}
          </Text>
        </View>

        <View style={styles.giantScoreContainer}>
          <Text
            style={[
              styles.giantScoreText,
              { color: isTeamACT ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            {teamA.score}
          </Text>
          <Text style={styles.giantScoreDivider}>:</Text>
          <Text
            style={[
              styles.giantScoreText,
              { color: isTeamBCT ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            {teamB.score}
          </Text>
        </View>

        <View
          style={[
            styles.teamHeaderBox,
            isTeamBCT ? styles.teamBoxCT : styles.teamBoxTR,
          ]}
        >
          <View
            style={[
              styles.sidePill,
              { backgroundColor: isTeamBCT ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            <Text style={styles.sidePillText}>{isTeamBCT ? 'CT' : 'TR'}</Text>
          </View>
          <Text style={styles.teamHeaderAcronym} numberOfLines={1}>
            {teamB.acronym ?? teamB.name}
          </Text>
          <Text style={styles.teamHeaderName} numberOfLines={1}>
            {teamB.name}
          </Text>
        </View>
      </View>
    </View>
  );
});

interface MatchStatusBlockProps {
  roundTimeRemainingMs: number;
  phase: string;
  bomb: CS2BombStatus;
}

const MatchStatusBlock = memo(function MatchStatusBlock({
  roundTimeRemainingMs,
  phase,
  bomb,
}: MatchStatusBlockProps): React.JSX.Element {
  const bombInfo = getBombDisplay(bomb);

  return (
    <View style={styles.statusCard}>
      <View style={styles.statusMetricColumn}>
        <Text style={styles.statusLabel}>RELÓGIO DO ROUND</Text>
        <Text style={styles.clockValueText}>{formatRoundClock(roundTimeRemainingMs)}</Text>
        <Text style={styles.phaseSubText}>FASE: {phase.toUpperCase()}</Text>
      </View>

      <View style={styles.statusVerticalDivider} />

      <View style={styles.statusMetricColumn}>
        <Text style={styles.statusLabel}>STATUS DA BOMBA</Text>
        <Text style={[styles.bombValueText, { color: bombInfo.color }]}>
          {bombInfo.label}
        </Text>
      </View>
    </View>
  );
});

interface PlayerRowProps {
  player: CS2PlayerLiveStats;
  side: CS2Side;
}

const PlayerStatRow = memo(function PlayerStatRow({
  player,
  side,
}: PlayerRowProps): React.JSX.Element {
  const sideColor = side === 'CT' ? COLORS.ctAccent : COLORS.trAccent;

  return (
    <View style={[styles.playerRow, !player.alive && styles.playerRowEliminated]}>
      <View style={styles.playerNameContainer}>
        <View style={[styles.sideIndicatorBar, { backgroundColor: sideColor }]} />
        <Text style={styles.playerNickname} numberOfLines={1}>
          {player.nickname}
        </Text>
      </View>

      <View style={styles.playerStatsRight}>
        <Text style={styles.kdaText}>
          {player.kills}/{player.deaths}/{player.assists}
        </Text>
        <Text style={styles.bankText}>${player.money.toLocaleString('en-US')}</Text>
      </View>
    </View>
  );
});

interface LiveScoreboardProps {
  matchId: string;
  matchDetail: MatchDetailDto;
  liveState: CS2LiveState | null;
  isConnected: boolean;
  wsError: string | null;
}

const LiveScoreboard = memo(function LiveScoreboard({
  matchId,
  matchDetail,
  liveState,
  isConnected,
  wsError,
}: LiveScoreboardProps): React.JSX.Element {
  const { teamAPlayers, teamBPlayers } = useMemo(() => {
    if (!liveState) {
      return { teamAPlayers: [], teamBPlayers: [] };
    }
    const rosterA = (matchDetail.team_a?.players ?? []).map((p) => p.nickname);
    const rosterB = (matchDetail.team_b?.players ?? []).map((p) => p.nickname);

    return {
      teamAPlayers: resolveTeamPlayers(liveState.teams.teamA, liveState, rosterA),
      teamBPlayers: resolveTeamPlayers(liveState.teams.teamB, liveState, rosterB),
    };
  }, [liveState, matchDetail.team_a?.players, matchDetail.team_b?.players]);

  const roundTimeRemainingMs =
    liveState?.round_time_remaining_ms ?? liveState?.round.clock.remainingMs ?? 0;

  return (
    <View style={styles.screenContainer}>
      {!isConnected && (
        <View style={styles.reconnectingBanner}>
          <View style={styles.reconnectingDot} />
          <Text style={styles.reconnectingText}>Reconectando ao stream ao vivo...</Text>
        </View>
      )}

      {!liveState ? (
        <View style={styles.emptyStateCard}>
          <Text style={styles.emptyTitle}>Aguardando telemetria ao vivo da partida</Text>
          <Text style={styles.emptySubtitle}>
            {wsError ?? `${matchDetail.team_a?.name ?? 'Equipe A'} vs ${matchDetail.team_b?.name ?? 'Equipe B'} (${matchId})`}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <ScoreboardHeader
            teamA={liveState.teams.teamA}
            teamB={liveState.teams.teamB}
            mapName={liveState.currentMap.mapName}
            roundNumber={liveState.round.number}
            format={liveState.format}
          />

          <MatchStatusBlock
            roundTimeRemainingMs={roundTimeRemainingMs}
            phase={liveState.round.phase}
            bomb={liveState.bomb}
          />

          <View style={styles.playersSectionCard}>
            <View style={styles.playersGroupHeader}>
              <Text
                style={[
                  styles.playersTeamTitle,
                  {
                    color:
                      liveState.teams.teamA.side === 'CT'
                        ? COLORS.ctAccent
                        : COLORS.trAccent,
                  },
                ]}
              >
                {liveState.teams.teamA.name} ({liveState.teams.teamA.side === 'CT' ? 'CT' : 'TR'}) · Bank $
                {liveState.teams.teamA.economy.money.toLocaleString('en-US')}
              </Text>
              <Text style={styles.columnHeadersText}>K/D/A · BANK</Text>
            </View>

            {teamAPlayers.map((player) => (
              <PlayerStatRow
                key={player.playerId}
                player={player}
                side={liveState.teams.teamA.side}
              />
            ))}

            <View style={styles.teamSectionSpacer} />

            <View style={styles.playersGroupHeader}>
              <Text
                style={[
                  styles.playersTeamTitle,
                  {
                    color:
                      liveState.teams.teamB.side === 'CT'
                        ? COLORS.ctAccent
                        : COLORS.trAccent,
                  },
                ]}
              >
                {liveState.teams.teamB.name} ({liveState.teams.teamB.side === 'CT' ? 'CT' : 'TR'}) · Bank $
                {liveState.teams.teamB.economy.money.toLocaleString('en-US')}
              </Text>
              <Text style={styles.columnHeadersText}>K/D/A · BANK</Text>
            </View>

            {teamBPlayers.map((player) => (
              <PlayerStatRow
                key={player.playerId}
                player={player}
                side={liveState.teams.teamB.side}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
});

// =============================================================================
// Componente Principal — LiveMatchScreen (Orquestrador Pré / Live / Pós)
// =============================================================================
// [UPDATE]: Intervalo de Smart Polling (15s) para partidas pré-jogo ('not_started'
// ou 'scheduled'), permitindo transição automática para <LiveScoreboard /> + WebSocket
// assim que a partida iniciar no servidor.
const SMART_POLL_INTERVAL_MS = 15_000;

export function LiveMatchScreen({ route }: LiveMatchScreenProps): React.JSX.Element {
  const { matchId } = route.params;

  const [matchDetail, setMatchDetail] = useState<MatchDetailDto | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(true);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(async (): Promise<void> => {
    setLoadingDetail(true);
    try {
      const detail = await fetchMatchById(matchId);
      setMatchDetail(detail);
      setDetailError(null);
    } catch (err: unknown) {
      setDetailError(
        err instanceof Error
          ? err.message
          : 'Não foi possível carregar os detalhes da partida.',
      );
    } finally {
      setLoadingDetail(false);
    }
  }, [matchId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  // ---------------------------------------------------------------------------
  // [UPDATE]: Smart Polling para Auto-Transição Pré-Jogo -> Ao Vivo
  // O QUE: Monitora `matchDetail.status`. Enquanto a partida estiver em estado
  //        pré-jogo (`'not_started'` ou `'scheduled'`), consulta silenciosamente
  //        `GET /api/matches/:id` a cada 15 segundos.
  // POR QUE:
  //   - Sem `setLoadingDetail(true)` no background, evita piscar a tela ou perder
  //     a aba selecionada no `<PreMatchStats />`.
  //   - Assim que a API retorna `status === 'live'` (ou `'finished'`), atualiza
  //     `matchDetail`, o que: (1) dispara o cleanup `clearInterval` imediatamente,
  //     (2) desmonta `<PreMatchStats />`, (3) monta `<LiveScoreboard />` e
  //     (4) ativa `useLiveMatch(matchId)` abrindo o WebSocket da Cito Sports.
  // ---------------------------------------------------------------------------
  const currentStatus = matchDetail?.status;
  const shouldPollPreMatch =
    currentStatus === 'not_started' || currentStatus === 'scheduled';

  useEffect(() => {
    if (!shouldPollPreMatch) {
      return;
    }

    let isCancelled = false;
    let isRequestInFlight = false;

    const intervalId = setInterval(() => {
      if (isCancelled || isRequestInFlight) {
        return;
      }
      isRequestInFlight = true;

      fetchMatchById(matchId)
        .then((freshDetail) => {
          if (isCancelled) return;
          setMatchDetail((prev) => {
            if (!prev) return freshDetail;
            if (
              prev.status !== freshDetail.status ||
              prev.scheduled_at !== freshDetail.scheduled_at ||
              prev.winner_id !== freshDetail.winner_id
            ) {
              return freshDetail;
            }
            return prev;
          });
        })
        .catch(() => {
          // Oscilações transitórias durante o polling silencioso são ignoradas
          // para manter a interface pré-jogo estável na tela.
        })
        .finally(() => {
          isRequestInFlight = false;
        });
    }, SMART_POLL_INTERVAL_MS);

    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [matchId, shouldPollPreMatch]);

  // [UPDATE]: O WebSocket SÓ é instanciado e consumido quando `match.status === 'live'`.
  const isLiveMatch = matchDetail?.status === 'live';
  const { liveState, isConnected, error: wsError } = useLiveMatch(
    isLiveMatch ? matchId : null,
  );

  if (loadingDetail) {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator color="#FFFFFF" size="large" />
        <Text style={styles.loadingText}>Carregando detalhes da partida...</Text>
      </View>
    );
  }

  if (!matchDetail || detailError) {
    return (
      <View style={styles.screenContainer}>
        <View style={styles.emptyStateCard}>
          <Text style={styles.emptyTitle}>Falha ao carregar partida</Text>
          <Text style={styles.emptySubtitle}>
            {detailError ?? `Partida ${matchId} não encontrada.`}
          </Text>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // [UPDATE]: Renderização Condicional pelos 3 estados da partida:
  //   - 'live'                         -> <LiveScoreboard />
  //   - 'finished'                     -> <PostMatchSummary />
  //   - 'not_started' / 'scheduled'    -> <PreMatchStats />
  // ---------------------------------------------------------------------------
  if (matchDetail.status === 'live') {
    return (
      <LiveScoreboard
        matchId={matchId}
        matchDetail={matchDetail}
        liveState={liveState}
        isConnected={isConnected}
        wsError={wsError}
      />
    );
  }

  if (matchDetail.status === 'finished') {
    return (
      <View style={styles.screenContainer}>
        <PostMatchSummary match={matchDetail} />
      </View>
    );
  }

  // `status === 'not_started' | 'scheduled' | 'postponed' | 'canceled'`
  return (
    <View style={styles.screenContainer}>
      <PreMatchStats match={matchDetail} />
    </View>
  );
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  centeredContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginTop: 12,
  },
  reconnectingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1C1C1E',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  reconnectingDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.trAccent,
    marginRight: 8,
  },
  reconnectingText: {
    color: COLORS.trAccent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },
  scoreboardCard: {
    backgroundColor: COLORS.card,
    borderRadius: 18,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  mapHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  mapNameText: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  roundBadgeText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  scoreboardMainRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  teamHeaderBox: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  teamBoxCT: {
    backgroundColor: COLORS.ctSubtleBg,
    borderColor: COLORS.ctSubtleBorder,
  },
  teamBoxTR: {
    backgroundColor: COLORS.trSubtleBg,
    borderColor: COLORS.trSubtleBorder,
  },
  sidePill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginBottom: 6,
  },
  sidePillText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  teamHeaderAcronym: {
    color: COLORS.textPrimary,
    fontSize: 20,
    fontWeight: '800',
  },
  teamHeaderName: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  giantScoreContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  giantScoreText: {
    fontSize: 40,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  giantScoreDivider: {
    color: COLORS.textSecondary,
    fontSize: 28,
    fontWeight: '700',
    marginHorizontal: 6,
  },
  statusCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  statusMetricColumn: {
    flex: 1,
    alignItems: 'center',
  },
  statusVerticalDivider: {
    width: 1,
    height: 40,
    backgroundColor: COLORS.cardBorder,
    marginHorizontal: 10,
  },
  statusLabel: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  clockValueText: {
    color: COLORS.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  phaseSubText: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
  bombValueText: {
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  playersSectionCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  playersGroupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  playersTeamTitle: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  columnHeadersText: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  playerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.cardBorder,
  },
  playerRowEliminated: {
    opacity: 0.45,
  },
  playerNameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  sideIndicatorBar: {
    width: 3,
    height: 16,
    borderRadius: 2,
    marginRight: 10,
  },
  playerNickname: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  playerStatsRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kdaText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginRight: 14,
  },
  bankText: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 58,
    textAlign: 'right',
  },
  teamSectionSpacer: {
    height: 18,
  },
  emptyStateCard: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    padding: 24,
    margin: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  emptyTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptySubtitle: {
    color: COLORS.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
});
