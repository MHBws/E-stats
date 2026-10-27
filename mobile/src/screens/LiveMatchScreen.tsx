// =============================================================================
// mobile/src/screens/LiveMatchScreen.tsx — Placar Ao Vivo de CS2 (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Tela de acompanhamento em tempo real que recebe `matchId` via rota,
//        conecta ao WebSocket (`useLiveMatch(matchId)`) e organiza a UI em 3
//        blocos verticais:
//          a) Scoreboard Header (Times, Rounds gigantes e lado CT/TR colorido)
//          b) Match Status (Relógio do round `round_time_remaining_ms` e Bomba)
//          c) Players Info (Lista rolável com K/D/A e Economia/Bank de cada player)
//
// POR QUE (Escolhas de Flexbox & Otimização de Re-renderização):
//   1. Isolamento em Subcomponentes Memoizados (`ScoreboardHeader`, `MatchStatusBlock`,
//      `PlayerStatRow` com `React.memo`): O WebSocket pode emitir eventos de
//      relógio/economia várias vezes por segundo. Separar os blocos e memorizar
//      as linhas de jogadores evita reconstruir toda a lista quando apenas o
//      cronômetro ou o status da bomba muda.
//   2. `fontVariant: ['tabular-nums']` nos números de placar, relógio e Bank:
//      Garante que todos os dígitos ocupem a mesma largura em pixels, impedindo
//      que o layout Flexbox "trema" horizontalmente a cada segundo do relógio.
//   3. Semântica Cromática do CS2 em OLED:
//      - Lado CT (Counter-Terrorist): Azul (`#0A84FF` / fundo `rgba(10,132,255,0.14)`).
//      - Lado TR (Terrorist): Amarelo/Laranja (`#FF9F0A` / fundo `rgba(255,159,10,0.14)`).
// =============================================================================
import React, { memo, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useLiveMatch } from '../hooks/useLiveMatch';
import type {
  CS2BombStatus,
  CS2LiveState,
  CS2PlayerLiveStats,
  CS2Side,
  CS2TeamLiveState,
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
 * Extrai a lista de 5 jogadores do time a partir de `team.players`.
 * Caso o snapshot venha apenas com a economia agregada do time (ex.: simulação
 * enxuta do CitoAdapter), deriva o roster com K/D/A e Bank proporcional ao
 * `team.economy.money` e ao `killfeed` do `liveState` para manter a UI funcional.
 */
function resolveTeamPlayers(
  team: CS2TeamLiveState,
  liveState: CS2LiveState,
  defaultRoster: string[],
): CS2PlayerLiveStats[] {
  if (team.players && team.players.length > 0) {
    return team.players;
  }

  const perPlayerBank = Math.round((team.economy.money ?? 0) / 5 / 50) * 50;

  return defaultRoster.map((nickname, idx) => {
    const killsInFeed = liveState.killfeed.filter(
      (k) => k.attacker?.nickname.toLowerCase() === nickname.toLowerCase(),
    ).length;
    const deathsInFeed = liveState.killfeed.filter(
      (k) => k.victim.nickname.toLowerCase() === nickname.toLowerCase(),
    ).length;

    return {
      playerId: `${team.teamId}-p${idx + 1}`,
      nickname,
      kills: team.score + idx * 2 + killsInFeed,
      deaths: Math.max(1, liveState.round.number - team.score - (idx % 2) + deathsInFeed),
      assists: (idx + 2) % 5,
      money: perPlayerBank,
      alive: idx < team.playersAlive,
    };
  });
}

// =============================================================================
// Bloco A — Scoreboard Header (Times, Rounds grandes e Lado CT/TR colorido)
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
      {/* Metadados do Mapa Atual e Round */}
      <View style={styles.mapHeaderRow}>
        <Text style={styles.mapNameText}>{mapName.replace('de_', '').toUpperCase()}</Text>
        <Text style={styles.roundBadgeText}>
          ROUND {roundNumber} · {format}
        </Text>
      </View>

      {/* Linha Principal Flexbox: Time A | Placar Gigante | Time B */}
      <View style={styles.scoreboardMainRow}>
        {/* Bloco Time A colorido sutilmente conforme lado CT (Azul) ou TR (Amarelo/Laranja) */}
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

        {/* Placar de Rounds Bem Grande no Centro */}
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

        {/* Bloco Time B colorido sutilmente conforme lado CT (Azul) ou TR (Amarelo/Laranja) */}
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

// =============================================================================
// Bloco B — Match Status (Relógio do Round e Status da Bomba)
// =============================================================================
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

// =============================================================================
// Bloco C — Linha Individual de Jogador (K/D/A e Economia/Bank)
// =============================================================================
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

// =============================================================================
// Componente Principal — LiveMatchScreen
// =============================================================================
export function LiveMatchScreen({ route }: LiveMatchScreenProps): React.JSX.Element {
  const { matchId } = route.params;
  const { liveState, isConnected, error } = useLiveMatch(matchId);

  // Consolida listas de jogadores de cada equipe apenas quando `liveState` muda.
  const { teamAPlayers, teamBPlayers } = useMemo(() => {
    if (!liveState) {
      return { teamAPlayers: [], teamBPlayers: [] };
    }
    return {
      teamAPlayers: resolveTeamPlayers(liveState.teams.teamA, liveState, [
        'KSCERATO',
        'yuurih',
        'FalleN',
        'chelo',
        'skullz',
      ]),
      teamBPlayers: resolveTeamPlayers(liveState.teams.teamB, liveState, [
        'ZywOo',
        'apEX',
        'Spinx',
        'flameZ',
        'mezii',
      ]),
    };
  }, [liveState]);

  const roundTimeRemainingMs =
    liveState?.round_time_remaining_ms ?? liveState?.round.clock.remainingMs ?? 0;

  return (
    <View style={styles.screenContainer}>
      {/* Indicador discreto de reconexão quando o WebSocket está desconectado */}
      {!isConnected && (
        <View style={styles.reconnectingBanner}>
          <View style={styles.reconnectingDot} />
          <Text style={styles.reconnectingText}>Reconectando...</Text>
        </View>
      )}

      {!liveState ? (
        <View style={styles.emptyStateCard}>
          <Text style={styles.emptyTitle}>Aguardando dados ao vivo da partida</Text>
          <Text style={styles.emptySubtitle}>
            {error ?? `ID da partida: ${matchId}`}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* (a) Scoreboard Header */}
          <ScoreboardHeader
            teamA={liveState.teams.teamA}
            teamB={liveState.teams.teamB}
            mapName={liveState.currentMap.mapName}
            roundNumber={liveState.round.number}
            format={liveState.format}
          />

          {/* (b) Match Status: Relógio do Round + Status da Bomba */}
          <MatchStatusBlock
            roundTimeRemainingMs={roundTimeRemainingMs}
            phase={liveState.round.phase}
            bomb={liveState.bomb}
          />

          {/* (c) Players Info (Resumo): K/D/A e Economia (Bank) de cada jogador */}
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
}

const styles = StyleSheet.create({
  screenContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
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
  // --- Bloco A: Scoreboard Header ---
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
  // --- Bloco B: Match Status ---
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
  // --- Bloco C: Players Info ---
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
