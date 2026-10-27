// =============================================================================
// mobile/src/components/PostMatchSummary.tsx — Resumo Pós-Jogo (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Renderiza o relatório consolidado de uma partida encerrada
//        (`status === 'finished'`), dividido em 3 blocos:
//          1. Placar Final da Série em destaque (ex.: 2 - 1) com escudos e
//             destaque visual para o vencedor.
//          2. Resultados por Mapa jogado (ex.: Mirage 13 - 9, Inferno 10 - 13).
//          3. Tabela de Estatísticas Finais dos jogadores ordenada por Rating e
//             K/D/A, mantendo o design Dark Mode OLED sem relógio nem C4.
// =============================================================================
import React, { memo, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  MatchDetailDto,
  MatchTeamSummary,
  PostMatchPlayerStatDto,
} from '../types/match';

export interface PostMatchSummaryProps {
  match: MatchDetailDto;
}

function resolveTeamAcronym(team: MatchTeamSummary | null): string {
  if (!team) return 'TBD';
  if (team.acronym?.trim()) return team.acronym.trim();
  if (team.name?.trim()) return team.name.trim().slice(0, 3).toUpperCase();
  return 'TBD';
}

interface PostMatchPlayerRowProps {
  stat: PostMatchPlayerStatDto;
  rank: number;
  isTeamA: boolean;
}

const PostMatchPlayerRow = memo(function PostMatchPlayerRow({
  stat,
  rank,
  isTeamA,
}: PostMatchPlayerRowProps): React.JSX.Element {
  const accentColor = isTeamA ? '#0A84FF' : '#FF9F0A';
  const ratingHigh = stat.rating >= 1.15;

  return (
    <View style={styles.playerRow}>
      <View style={styles.playerLeftGroup}>
        <Text style={styles.rankText}>{rank}</Text>
        <View style={[styles.teamAccentBar, { backgroundColor: accentColor }]} />
        <View style={styles.playerIdentityBox}>
          <Text style={styles.playerNickname} numberOfLines={1}>
            {stat.nickname}
          </Text>
          <Text style={styles.playerTeamSub} numberOfLines={1}>
            {stat.team_acronym ?? stat.team_name}
            {stat.nationality ? ` · ${stat.nationality}` : ''}
          </Text>
        </View>
      </View>

      <View style={styles.playerMetricsRight}>
        <Text style={styles.kdaMetricText}>
          {stat.kills}/{stat.deaths}/{stat.assists}
        </Text>
        <Text style={styles.adrMetricText}>{stat.adr.toFixed(0)}</Text>
        <View
          style={[
            styles.ratingPill,
            ratingHigh && styles.ratingPillHigh,
          ]}
        >
          <Text
            style={[
              styles.ratingValueText,
              ratingHigh && styles.ratingValueTextHigh,
            ]}
          >
            {stat.rating.toFixed(2)}
          </Text>
        </View>
      </View>
    </View>
  );
});

function PostMatchSummaryComponent({ match }: PostMatchSummaryProps): React.JSX.Element {
  const [logoAError, setLogoAError] = useState<boolean>(false);
  const [logoBError, setLogoBError] = useState<boolean>(false);

  const teamALogo = match.team_a?.logo_url?.trim() || null;
  const teamBLogo = match.team_b?.logo_url?.trim() || null;

  const targetWins = match.format === 'BO1' ? 1 : match.format === 'BO5' ? 3 : 2;
  const teamAScore =
    match.results?.team_a_score ??
    (match.winner_id && match.winner_id === match.team_a?.id ? targetWins : 0);
  const teamBScore =
    match.results?.team_b_score ??
    (match.winner_id && match.winner_id === match.team_b?.id ? targetWins : 0);

  const isTeamAWinner =
    (match.winner_id !== null && match.winner_id === match.team_a?.id) ||
    teamAScore > teamBScore;
  const isTeamBWinner =
    (match.winner_id !== null && match.winner_id === match.team_b?.id) ||
    teamBScore > teamAScore;

  const finishedMaps = useMemo(
    () => match.maps.filter((m) => m.status === 'finished' || m.team_a_score > 0 || m.team_b_score > 0),
    [match.maps],
  );

  const sortedPlayersStats = useMemo(() => {
    const list = match.players_stats ?? [];
    return [...list].sort((a, b) => b.rating - a.rating || b.kills - a.kills);
  }, [match.players_stats]);

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {/* Bloco 1: Placar Final Consolidado da Série */}
      <View style={styles.scoreboardCard}>
        <View style={styles.headerMetaRow}>
          <Text style={styles.tournamentText} numberOfLines={1}>
            {match.tournament.name}
          </Text>
          <View style={styles.finishedBadge}>
            <Text style={styles.finishedBadgeText}>ENCERRADO · {match.format}</Text>
          </View>
        </View>

        <View style={styles.mainScoreRow}>
          {/* Equipe A */}
          <View style={[styles.teamColumn, isTeamBWinner && styles.teamColumnDimmed]}>
            <View style={styles.logoContainer}>
              {teamALogo && !logoAError ? (
                <Image
                  source={{ uri: teamALogo }}
                  style={styles.teamLogo}
                  resizeMode="contain"
                  onError={() => setLogoAError(true)}
                />
              ) : (
                <Text style={styles.teamAcronymFallback}>
                  {resolveTeamAcronym(match.team_a)}
                </Text>
              )}
            </View>
            <Text style={styles.teamNameText} numberOfLines={1}>
              {match.team_a?.name ?? 'Equipe A'}
            </Text>
            {isTeamAWinner && <Text style={styles.winnerTagText}>VENCEDOR</Text>}
          </View>

          {/* Placar Consolidado Central (ex: 2 - 1) */}
          <View style={styles.seriesScoreBox}>
            <Text
              style={[
                styles.seriesScoreDigit,
                isTeamAWinner && styles.seriesScoreDigitWinner,
              ]}
            >
              {teamAScore}
            </Text>
            <Text style={styles.seriesScoreDash}>-</Text>
            <Text
              style={[
                styles.seriesScoreDigit,
                isTeamBWinner && styles.seriesScoreDigitWinner,
              ]}
            >
              {teamBScore}
            </Text>
          </View>

          {/* Equipe B */}
          <View style={[styles.teamColumn, isTeamAWinner && styles.teamColumnDimmed]}>
            <View style={styles.logoContainer}>
              {teamBLogo && !logoBError ? (
                <Image
                  source={{ uri: teamBLogo }}
                  style={styles.teamLogo}
                  resizeMode="contain"
                  onError={() => setLogoBError(true)}
                />
              ) : (
                <Text style={styles.teamAcronymFallback}>
                  {resolveTeamAcronym(match.team_b)}
                </Text>
              )}
            </View>
            <Text style={styles.teamNameText} numberOfLines={1}>
              {match.team_b?.name ?? 'Equipe B'}
            </Text>
            {isTeamBWinner && <Text style={styles.winnerTagText}>VENCEDOR</Text>}
          </View>
        </View>
      </View>

      {/* Bloco 2: Resultados por Mapa */}
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>RESULTADOS POR MAPA</Text>

        {finishedMaps.length === 0 ? (
          <Text style={styles.emptySectionText}>
            Placar detalhado por mapa indisponível para esta série.
          </Text>
        ) : (
          finishedMaps.map((mapItem) => {
            const mapAWon = mapItem.team_a_score > mapItem.team_b_score;
            const mapBWon = mapItem.team_b_score > mapItem.team_a_score;

            return (
              <View key={mapItem.id} style={styles.mapResultRow}>
                <View style={styles.mapLeftInfo}>
                  <Text style={styles.mapNumberBadge}>MAPA {mapItem.map_number}</Text>
                  <Text style={styles.mapNameText}>{mapItem.map_name}</Text>
                </View>

                <View style={styles.mapScoreRight}>
                  <Text
                    style={[
                      styles.mapTeamScoreText,
                      mapAWon && styles.mapTeamScoreWinner,
                    ]}
                  >
                    {resolveTeamAcronym(match.team_a)} {mapItem.team_a_score}
                  </Text>
                  <Text style={styles.mapScoreSeparator}>:</Text>
                  <Text
                    style={[
                      styles.mapTeamScoreText,
                      mapBWon && styles.mapTeamScoreWinner,
                    ]}
                  >
                    {mapItem.team_b_score} {resolveTeamAcronym(match.team_b)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      {/* Bloco 3: Estatísticas Finais dos Jogadores Ordenados por Performance */}
      <View style={styles.sectionCard}>
        <View style={styles.statsHeaderRow}>
          <Text style={styles.sectionTitleNoMargin}>
            ESTATÍSTICAS DOS JOGADORES (POR RATING)
          </Text>
          <View style={styles.statsColumnsRight}>
            <Text style={styles.statsColLabel}>K/D/A</Text>
            <Text style={styles.statsColLabel}>ADR</Text>
            <Text style={styles.statsColLabel}>RTG</Text>
          </View>
        </View>

        {sortedPlayersStats.length === 0 ? (
          <Text style={styles.emptySectionText}>
            Estatísticas individuais não registradas para esta partida.
          </Text>
        ) : (
          sortedPlayersStats.map((stat, idx) => (
            <PostMatchPlayerRow
              key={stat.player_id}
              stat={stat}
              rank={idx + 1}
              isTeamA={stat.team_id === match.team_a?.id}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}

export const PostMatchSummary = memo(PostMatchSummaryComponent);

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },
  scoreboardCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 18,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  headerMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  tournamentText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  finishedBadge: {
    backgroundColor: '#2C2C2E',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  finishedBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  mainScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  teamColumn: {
    flex: 1,
    alignItems: 'center',
  },
  teamColumnDimmed: {
    opacity: 0.55,
  },
  logoContainer: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  teamLogo: {
    width: 52,
    height: 52,
  },
  teamAcronymFallback: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  teamNameText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
  winnerTagText: {
    color: '#22c55e',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    marginTop: 4,
  },
  seriesScoreBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  seriesScoreDigit: {
    color: '#8E8E93',
    fontSize: 38,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  seriesScoreDigitWinner: {
    color: '#FFFFFF',
  },
  seriesScoreDash: {
    color: '#8E8E93',
    fontSize: 24,
    fontWeight: '700',
    marginHorizontal: 8,
  },
  sectionCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  sectionTitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 12,
  },
  sectionTitleNoMargin: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    flex: 1,
  },
  mapResultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  mapLeftInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mapNumberBadge: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '800',
    marginRight: 10,
    letterSpacing: 0.5,
  },
  mapNameText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  mapScoreRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  mapTeamScoreText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  mapTeamScoreWinner: {
    color: '#22c55e',
    fontWeight: '800',
  },
  mapScoreSeparator: {
    color: '#8E8E93',
    fontSize: 13,
    marginHorizontal: 6,
  },
  statsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  statsColumnsRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statsColLabel: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '700',
    width: 48,
    textAlign: 'right',
  },
  playerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  playerLeftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rankText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    width: 20,
    fontVariant: ['tabular-nums'],
  },
  teamAccentBar: {
    width: 3,
    height: 18,
    borderRadius: 2,
    marginRight: 10,
  },
  playerIdentityBox: {
    flex: 1,
  },
  playerNickname: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  playerTeamSub: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },
  playerMetricsRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kdaMetricText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    width: 58,
    textAlign: 'right',
  },
  adrMetricText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    width: 40,
    textAlign: 'right',
    marginRight: 8,
  },
  ratingPill: {
    backgroundColor: '#2C2C2E',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    minWidth: 44,
    alignItems: 'center',
  },
  ratingPillHigh: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
  },
  ratingValueText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  ratingValueTextHigh: {
    color: '#22c55e',
  },
  emptySectionText: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 12,
  },
});
