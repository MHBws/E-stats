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
  Image,
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
  CS2LiveMapItem,
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

/** Limpa e formata o nome do mapa (ex.: 'de_nuke' -> 'Nuke'). */
function cleanMapName(raw?: string | null): string {
  if (!raw) return 'TBD';
  const stripped = raw.replace(/^de_/, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Formata o rótulo do formato da série (ex.: 'Melhor de 3'). */
function formatSeriesLabel(format?: string): string {
  switch (format) {
    case 'BO1':
      return 'Melhor de 1';
    case 'BO5':
      return 'Melhor de 5';
    case 'BO3':
    default:
      return 'Melhor de 3';
  }
}

/** Quantidade de vitórias necessárias para vencer a série. */
function getTargetWins(format?: string): number {
  switch (format) {
    case 'BO1':
      return 1;
    case 'BO5':
      return 3;
    case 'BO3':
    default:
      return 2;
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
      money: 0,
      alive: idx < team.playersAlive,
    };
  });
}

/** Renderiza os indicadores circulares de mapas vencidos na série (estilo Sofascore). */
function renderWinDots(targetWins: number, currentWins: number): React.JSX.Element[] {
  const dots: React.JSX.Element[] = [];
  for (let i = 0; i < targetWins; i += 1) {
    const isWon = i < currentWins;
    dots.push(
      <View
        key={`dot-${i}`}
        style={[styles.winDot, isWon ? styles.winDotFilled : styles.winDotEmpty]}
      />,
    );
  }
  return dots;
}

// =============================================================================
// Subcomponente `<LiveScoreboard />` — Renderizado apenas quando `status === 'live'`
// =============================================================================
// =============================================================================
// Subcomponente `<LiveScoreboard />` — Renderizado apenas quando `status === 'live'`
// =============================================================================
interface ScoreboardHeaderProps {
  teamA: CS2TeamLiveState;
  teamB: CS2TeamLiveState;
  teamALogoUrl?: string | null;
  teamBLogoUrl?: string | null;
  sideA: CS2Side;
  sideB: CS2Side;
  mapName: string;
  roundNumber: number;
  format: string;
  phaseLabel?: string;
}

const ScoreboardHeader = memo(function ScoreboardHeader({
  teamA,
  teamB,
  teamALogoUrl,
  teamBLogoUrl,
  sideA,
  sideB,
  mapName,
  roundNumber,
  format,
  phaseLabel,
}: ScoreboardHeaderProps): React.JSX.Element {
  const isTeamACT = sideA === 'CT';
  const isTeamBCT = sideB === 'CT';
  const isInterval = phaseLabel === 'Intervalo';

  return (
    <View style={styles.scoreboardCard}>
      <View style={styles.mapHeaderRow}>
        <Text style={styles.mapNameText}>{cleanMapName(mapName).toUpperCase()}</Text>
        <Text style={[styles.roundBadgeText, isInterval && styles.roundBadgeIntervalText]}>
          {isInterval ? 'INTERVALO' : `ROUND ${roundNumber} · ${format}`}
        </Text>
      </View>

      <View style={styles.scoreboardMainRow}>
        <View
          style={[
            styles.teamHeaderBox,
            isTeamACT ? styles.teamBoxCT : styles.teamBoxTR,
          ]}
        >
          {teamALogoUrl ? (
            <Image
              source={{ uri: teamALogoUrl }}
              style={styles.teamLogoHeader}
              resizeMode="contain"
            />
          ) : null}
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
          {teamBLogoUrl ? (
            <Image
              source={{ uri: teamBLogoUrl }}
              style={styles.teamLogoHeader}
              resizeMode="contain"
            />
          ) : null}
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

interface SeriesMapsSectionProps {
  format: string;
  maps: CS2LiveMapItem[];
  teamAMapsWon: number;
  teamBMapsWon: number;
  phaseLabel?: string;
}

const SeriesMapsSection = memo(function SeriesMapsSection({
  format,
  maps,
  teamAMapsWon,
  teamBMapsWon,
  phaseLabel,
}: SeriesMapsSectionProps): React.JSX.Element {
  const targetWins = getTargetWins(format);
  const isInterval = phaseLabel === 'Intervalo';

  return (
    <View style={styles.seriesSectionWrapper}>
      {/* Barra "Melhor de X" com indicadores de mapas vencidos */}
      <View style={styles.seriesBarContainer}>
        <View style={styles.seriesDotsRow}>
          {renderWinDots(targetWins, teamAMapsWon)}
        </View>
        <Text style={styles.seriesFormatText}>{formatSeriesLabel(format)}</Text>
        <View style={styles.seriesDotsRow}>
          {renderWinDots(targetWins, teamBMapsWon)}
        </View>
      </View>

      {/* Secção "Jogos" — Lista de mapas da série */}
      <Text style={styles.sectionTitle}>Jogos</Text>

      {maps.map((map, index) => {
        const mapNum = map.map_number ?? (map as unknown as { mapNumber?: number }).mapNumber ?? (index + 1);
        const mapTitle = cleanMapName(map.map_name ?? (map as unknown as { mapName?: string }).mapName);
        const scoreA = map.team_a_score ?? (map as unknown as { teamAScore?: number }).teamAScore ?? 0;
        const scoreB = map.team_b_score ?? (map as unknown as { teamBScore?: number }).teamBScore ?? 0;
        const isLive = map.status === 'live';
        const isFinished = map.status === 'finished';

        return (
          <View
            key={`map-${mapNum}`}
            style={[styles.mapCard, isLive && styles.mapCardLive]}
          >
            {/* Coluna Esquerda: Status / Selo */}
            <View style={styles.mapColLeft}>
              {isLive ? (
                isInterval ? (
                  <View style={styles.intervalBadgePill}>
                    <Text style={styles.intervalBadgeText}>INTERVALO</Text>
                  </View>
                ) : (
                  <View style={styles.liveBadgePill}>
                    <View style={styles.livePulseDot} />
                    <Text style={styles.liveBadgeText}>AO VIVO</Text>
                  </View>
                )
              ) : isFinished ? (
                <Text style={styles.mapStatusText}>Finalizado</Text>
              ) : (
                <Text style={styles.mapStatusText}>Aguardando</Text>
              )}
            </View>

            {/* Coluna Central: Placar */}
            <View style={styles.mapColCenter}>
              {isLive ? (
                <View style={styles.mapLiveScoreBadge}>
                  <Text style={styles.mapLiveScoreText}>
                    {scoreA} - {scoreB}
                  </Text>
                </View>
              ) : isFinished ? (
                <Text style={styles.mapScoreText}>
                  {scoreA} - {scoreB}
                </Text>
              ) : (
                <View style={styles.mapUpcomingBadge}>
                  <Text style={styles.mapUpcomingText}>-</Text>
                </View>
              )}
              {isLive ? (
                <Text style={isInterval ? styles.mapSubInfoIntervalo : styles.mapSubInfo}>
                  {isInterval ? 'Intervalo' : `Mapa ${mapNum}`}
                </Text>
              ) : isFinished ? (
                <Text style={styles.mapSubInfo}>{map.duration ?? '50 min'}</Text>
              ) : null}
            </View>

            {/* Coluna Direita: Número do jogo e nome do mapa */}
            <View style={styles.mapColRight}>
              <Text style={styles.gameLabelText}>Game {mapNum}</Text>
              <View style={styles.mapNameRow}>
                <Text style={styles.mapTitleLabel} numberOfLines={1}>
                  {mapTitle}
                </Text>
                <Text style={styles.mapChevronIcon}>›</Text>
              </View>
            </View>
          </View>
        );
      })}
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
      </View>
    </View>
  );
});

interface PlayersSectionProps {
  teamA: CS2TeamLiveState;
  teamB: CS2TeamLiveState;
  teamAPlayers: CS2PlayerLiveStats[];
  teamBPlayers: CS2PlayerLiveStats[];
  teamALogoUrl?: string | null;
  teamBLogoUrl?: string | null;
  sideA: CS2Side;
  sideB: CS2Side;
}

const PlayersSection = memo(function PlayersSection({
  teamA,
  teamB,
  teamAPlayers,
  teamBPlayers,
  teamALogoUrl,
  teamBLogoUrl,
  sideA,
  sideB,
}: PlayersSectionProps): React.JSX.Element {
  return (
    <View style={styles.playersSectionCard}>
      <Text style={styles.sectionTitle}>Jogadores</Text>

      {/* Header Equipe A com logotipo */}
      <View style={styles.playersGroupHeader}>
        <View style={styles.teamHeaderLeftRow}>
          {teamALogoUrl ? (
            <Image
              source={{ uri: teamALogoUrl }}
              style={styles.teamLogoMini}
              resizeMode="contain"
            />
          ) : (
            <View style={styles.teamLogoFallback}>
              <Text style={styles.teamLogoFallbackText}>
                {teamA.acronym?.charAt(0) ?? teamA.name.charAt(0)}
              </Text>
            </View>
          )}
          <Text style={styles.playersTeamTitle} numberOfLines={1}>
            {teamA.name}
          </Text>
          <View
            style={[
              styles.sidePillInline,
              { backgroundColor: sideA === 'CT' ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            <Text style={styles.sidePillInlineText}>{sideA}</Text>
          </View>
        </View>
        <Text style={styles.columnHeadersText}>K / D / A</Text>
      </View>

      {teamAPlayers.map((player) => (
        <PlayerStatRow
          key={player.playerId}
          player={player}
          side={sideA}
        />
      ))}

      <View style={styles.teamSectionSpacer} />

      {/* Header Equipe B com logotipo */}
      <View style={styles.playersGroupHeader}>
        <View style={styles.teamHeaderLeftRow}>
          {teamBLogoUrl ? (
            <Image
              source={{ uri: teamBLogoUrl }}
              style={styles.teamLogoMini}
              resizeMode="contain"
            />
          ) : (
            <View style={styles.teamLogoFallback}>
              <Text style={styles.teamLogoFallbackText}>
                {teamB.acronym?.charAt(0) ?? teamB.name.charAt(0)}
              </Text>
            </View>
          )}
          <Text style={styles.playersTeamTitle} numberOfLines={1}>
            {teamB.name}
          </Text>
          <View
            style={[
              styles.sidePillInline,
              { backgroundColor: sideB === 'CT' ? COLORS.ctAccent : COLORS.trAccent },
            ]}
          >
            <Text style={styles.sidePillInlineText}>{sideB}</Text>
          </View>
        </View>
        <Text style={styles.columnHeadersText}>K / D / A</Text>
      </View>

      {teamBPlayers.map((player) => (
        <PlayerStatRow
          key={player.playerId}
          player={player}
          side={sideB}
        />
      ))}
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

  // Lados dinâmicos CT/TR informados pela telemetria Cito
  const sideA: CS2Side =
    liveState?.team_sides?.[liveState.teams.teamA.teamId] ??
    liveState?.team_sides?.[liveState.teams.teamA.name] ??
    liveState?.teams.teamA.side ??
    'CT';
  const sideB: CS2Side =
    liveState?.team_sides?.[liveState.teams.teamB.teamId] ??
    liveState?.team_sides?.[liveState.teams.teamB.name] ??
    liveState?.teams.teamB.side ??
    'T';

  // Sincronização híbrida de mapas (PandaScore + Cito)
  const seriesMaps: CS2LiveMapItem[] = useMemo(() => {
    if (liveState?.maps && liveState.maps.length > 0) {
      return liveState.maps;
    }
    return (matchDetail.maps ?? []).map((m) => ({
      id: m.id,
      map_number: m.map_number,
      map_name: m.map_name,
      status: m.status,
      team_a_score: m.team_a_score,
      team_b_score: m.team_b_score,
    }));
  }, [liveState?.maps, matchDetail.maps]);

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
            {wsError ??
              `${matchDetail.team_a?.name ?? 'Equipe A'} vs ${matchDetail.team_b?.name ?? 'Equipe B'} · ${matchDetail.tournament.name}${matchDetail.cito_match_id ? ` (${matchDetail.cito_match_id})` : ''}`}
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
            teamALogoUrl={matchDetail.team_a?.logo_url}
            teamBLogoUrl={matchDetail.team_b?.logo_url}
            sideA={sideA}
            sideB={sideB}
            mapName={liveState.currentMap.mapName}
            roundNumber={liveState.round.number}
            format={liveState.format}
            phaseLabel={liveState.phase_label}
          />

          <SeriesMapsSection
            format={liveState.format ?? matchDetail.format}
            maps={seriesMaps}
            teamAMapsWon={liveState.teams.teamA.mapsWon}
            teamBMapsWon={liveState.teams.teamB.mapsWon}
            phaseLabel={liveState.phase_label}
          />

          <PlayersSection
            teamA={liveState.teams.teamA}
            teamB={liveState.teams.teamB}
            teamAPlayers={teamAPlayers}
            teamBPlayers={teamBPlayers}
            teamALogoUrl={matchDetail.team_a?.logo_url}
            teamBLogoUrl={matchDetail.team_b?.logo_url}
            sideA={sideA}
            sideB={sideB}
          />
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
              prev.winner_id !== freshDetail.winner_id ||
              prev.cito_match_id !== freshDetail.cito_match_id
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

  // [UPDATE]: O WebSocket SÓ é instanciado quando `match.status === 'live'` e
  // prioriza `ws_match_id` / `cito_match_id` retornados pelo BFF para subscrição alinhada.
  const isLiveMatch = matchDetail?.status === 'live';
  const liveSubscriptionId = isLiveMatch
    ? (matchDetail.ws_match_id ?? matchDetail.cito_match_id ?? matchDetail.id)
    : null;
  const { liveState, isConnected, error: wsError } = useLiveMatch(liveSubscriptionId);

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
  roundBadgeIntervalText: {
    color: COLORS.trAccent,
    fontWeight: '800',
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
  teamLogoHeader: {
    width: 34,
    height: 34,
    borderRadius: 6,
    marginBottom: 6,
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
  seriesSectionWrapper: {
    marginBottom: 12,
  },
  seriesBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.card,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
  },
  seriesDotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  winDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  winDotFilled: {
    backgroundColor: COLORS.success,
  },
  winDotEmpty: {
    backgroundColor: '#3A3A3C',
    borderWidth: 1,
    borderColor: '#48484A',
  },
  seriesFormatText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    marginHorizontal: 16,
    letterSpacing: 0.3,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 10,
    letterSpacing: 0.3,
  },
  mapCard: {
    backgroundColor: COLORS.card,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mapCardLive: {
    borderColor: 'rgba(255, 69, 58, 0.45)',
    backgroundColor: '#1E1A1A',
  },
  mapColLeft: {
    width: 80,
    alignItems: 'flex-start',
  },
  mapColCenter: {
    alignItems: 'center',
    flex: 1,
  },
  mapColRight: {
    width: 95,
    alignItems: 'flex-end',
  },
  liveBadgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 69, 58, 0.35)',
  },
  livePulseDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: COLORS.danger,
    marginRight: 4,
  },
  liveBadgeText: {
    color: COLORS.danger,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  intervalBadgePill: {
    backgroundColor: 'rgba(255, 159, 10, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 159, 10, 0.4)',
  },
  intervalBadgeText: {
    color: COLORS.trAccent,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  mapStatusText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  mapScoreText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  mapLiveScoreBadge: {
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.danger,
    backgroundColor: 'rgba(255, 69, 58, 0.1)',
  },
  mapLiveScoreText: {
    color: COLORS.danger,
    fontSize: 16,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  mapUpcomingBadge: {
    width: 28,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  mapUpcomingText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  mapSubInfo: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '500',
    marginTop: 2,
  },
  mapSubInfoIntervalo: {
    color: COLORS.trAccent,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
  },
  gameLabelText: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  mapNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  mapTitleLabel: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  mapChevronIcon: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 3,
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
  teamHeaderLeftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  teamLogoMini: {
    width: 22,
    height: 22,
    borderRadius: 4,
    marginRight: 8,
  },
  teamLogoFallback: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#2C2C2E',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  teamLogoFallbackText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '800',
  },
  playersTeamTitle: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: COLORS.textPrimary,
    marginRight: 8,
  },
  sidePillInline: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  sidePillInlineText: {
    color: '#000000',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
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
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
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
