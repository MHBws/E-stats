// =============================================================================
// mobile/src/components/MatchCard.tsx — Card Minimalista de Partida (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Componente base de UI isolada para exibir um confronto (`MatchCardDto`).
// POR QUE: Segue a filosofia do Apple Sports — fundo escuro de alto contraste,
//          foco na sigla dos times (`acronym`), status ao vivo e tipografia limpa.
// =============================================================================
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { MatchCardDto } from '../types/match';

export interface MatchCardProps {
  match: MatchCardDto;
  onPress?: (matchId: string) => void;
}

export function MatchCard({ match, onPress }: MatchCardProps): React.JSX.Element {
  const isLive = match.status === 'live';
  const teamALabel = match.team_a?.acronym ?? match.team_a?.name ?? 'TBD';
  const teamBLabel = match.team_b?.acronym ?? match.team_b?.name ?? 'TBD';

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => onPress?.(match.id)}
      style={[styles.card, isLive && styles.cardLive]}
    >
      <View style={styles.headerRow}>
        <Text style={styles.tournamentText} numberOfLines={1}>
          {match.tournament.name} · {match.format}
        </Text>
        <Text style={[styles.statusBadge, isLive && styles.statusBadgeLive]}>
          {isLive ? 'LIVE' : match.status.toUpperCase()}
        </Text>
      </View>

      <View style={styles.teamsRow}>
        <Text style={styles.teamAcronym}>{teamALabel}</Text>
        <Text style={styles.versusText}>vs</Text>
        <Text style={styles.teamAcronym}>{teamBLabel}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#141416',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#242428',
  },
  cardLive: {
    borderColor: '#FF3B30',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  tournamentText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  statusBadge: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  statusBadgeLive: {
    color: '#FF3B30',
  },
  teamsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  teamAcronym: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  versusText: {
    color: '#636366',
    fontSize: 13,
    fontWeight: '600',
  },
});
