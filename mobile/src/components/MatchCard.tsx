// =============================================================================
// mobile/src/components/MatchCard.tsx — Card Minimalista de Partida (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Componente clicável (`Pressable`) que exibe um confronto (`MatchCardDto`)
//        com o campeonato no topo, indicador sutil "AO VIVO" e as duas equipes
//        alinhadas horizontalmente com o placar/horário centralizado.
//
// POR QUE (Escolhas de Flexbox & Otimização de Re-renderização):
//   1. Flexbox Simétrico (`flexDirection: 'row', justifyContent: 'space-between'`):
//      Em telas mobile estreitas, nomes de times com tamanhos diferentes
//      (ex.: "G2" vs "Natus Vincere") costumam deslocar o placar do centro real.
//      Atribuímos `flex: 1` para cada bloco de time (esquerdo e direito) e
//      largura fixa/centralizada para o bloco do placar central — garantindo que
//      o placar fique geometricamente cravado no centro do card como no Apple Sports.
//   2. `React.memo`: Na Home Screen, uma `FlatList` pode conter dezenas de cards.
//      Envolver `MatchCard` em `React.memo` evita que cards inalterados sofram
//      re-renderização durante o Pull-to-Refresh ou atualizações pontuais.
// =============================================================================
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MatchCardDto } from '../types/match';

export interface MatchCardProps {
  match: MatchCardDto;
  // [UPDATE]: Módulo 8 — Callback disparado ao tocar no card para abrir a `LiveMatchScreen`.
  onPress?: (match: MatchCardDto) => void;
}

/** Formata o horário agendado (`HH:mm`) para partidas que ainda não iniciaram. */
function formatScheduledTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '--:--';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function MatchCardComponent({ match, onPress }: MatchCardProps): React.JSX.Element {
  const isLive = match.status === 'live';
  const isFinished = match.status === 'finished';

  const teamAAcronym = match.team_a?.acronym ?? 'TBD';
  const teamAName = match.team_a?.name ?? 'A definir';
  const teamBAcronym = match.team_b?.acronym ?? 'TBD';
  const teamBName = match.team_b?.name ?? 'A definir';

  return (
    // [UPDATE]: Módulo 8 — `Pressable` nativo com feedback tátil de opacidade
    // e paleta Dark Mode OLED (`#1C1C1E` sobre fundo `#000000`).
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress?.(match)}
      style={({ pressed }) => [
        styles.card,
        isLive && styles.cardLiveBorder,
        pressed && styles.cardPressed,
      ]}
    >
      {/* Topo do Card: Nome do Campeonato (pequeno e cinza #8E8E93) + Badge AO VIVO */}
      <View style={styles.headerRow}>
        <Text style={styles.tournamentText} numberOfLines={1}>
          {match.tournament.name}
          {match.tournament.tier ? ` · Tier ${match.tournament.tier}` : ''} · {match.format}
        </Text>

        {isLive ? (
          <View style={styles.liveBadgeContainer}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>AO VIVO</Text>
          </View>
        ) : (
          <Text style={styles.statusText}>
            {isFinished ? 'ENCERRADO' : formatScheduledTime(match.scheduled_at)}
          </Text>
        )}
      </View>

      {/* Corpo Principal: Time A | Placar Central | Time B */}
      <View style={styles.matchupRow}>
        {/* Coluna Esquerda (Time A) — `flex: 1` mantém simetria com o lado direito */}
        <View style={styles.teamColumnLeft}>
          <Text style={styles.teamAcronym} numberOfLines={1}>
            {teamAAcronym}
          </Text>
          <Text style={styles.teamFullName} numberOfLines={1}>
            {teamAName}
          </Text>
        </View>

        {/* Bloco Central — Placar em destaque ou "VS" para jogos futuros */}
        <View style={styles.scoreCenterBox}>
          {isLive || isFinished ? (
            <View style={styles.scoreNumbersRow}>
              <Text style={styles.scoreNumber}>1</Text>
              <Text style={styles.scoreSeparator}>-</Text>
              <Text style={styles.scoreNumber}>0</Text>
            </View>
          ) : (
            <Text style={styles.versusLabel}>VS</Text>
          )}
          <Text style={styles.formatSubLabel}>{match.format}</Text>
        </View>

        {/* Coluna Direita (Time B) — `flex: 1` + alinhamento à direita */}
        <View style={styles.teamColumnRight}>
          <Text style={styles.teamAcronym} numberOfLines={1}>
            {teamBAcronym}
          </Text>
          <Text style={styles.teamFullName} numberOfLines={1}>
            {teamBName}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// [UPDATE]: Módulo 8 — `memo` evita re-render se `match` e `onPress` não mudarem.
export const MatchCard = memo(MatchCardComponent);

const styles = StyleSheet.create({
  card: {
    // Paleta Dark Mode OLED obrigatória: Card #1C1C1E sobre fundo #000000.
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  cardLiveBorder: {
    borderColor: 'rgba(255, 69, 58, 0.45)',
  },
  cardPressed: {
    opacity: 0.78,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  tournamentText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
    marginRight: 10,
  },
  liveBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.14)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF453A',
    marginRight: 5,
  },
  liveBadgeText: {
    color: '#FF453A',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  statusText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  matchupRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  teamColumnLeft: {
    flex: 1,
    alignItems: 'flex-start',
    paddingRight: 8,
  },
  teamColumnRight: {
    flex: 1,
    alignItems: 'flex-end',
    paddingLeft: 8,
  },
  teamAcronym: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  teamFullName: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  scoreCenterBox: {
    minWidth: 76,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  scoreNumbersRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  scoreNumber: {
    color: '#FFFFFF',
    fontSize: 24,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  scoreSeparator: {
    color: '#8E8E93',
    fontSize: 18,
    fontWeight: '600',
    marginHorizontal: 6,
  },
  versusLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  formatSubLabel: {
    color: '#8E8E93',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
  },
});
