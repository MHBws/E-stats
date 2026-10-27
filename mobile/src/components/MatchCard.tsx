// =============================================================================
// mobile/src/components/MatchCard.tsx — Card Minimalista de Partida (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Componente clicável (`Pressable`) que exibe um confronto (`MatchCardDto`)
//        com o campeonato e data/hora no topo (destacando jogos de "Hoje" em
//        verde `#22c55e`), indicador "AO VIVO" e as duas equipes alinhadas às
//        extremidades com seus logotipos (`48x48`, fallback para sigla) e o
//        placar/VS centralizado.
//
// POR QUE (Escolhas de Flexbox & Otimização de Re-renderização):
//   1. Flexbox Simétrico (`flexDirection: 'row', justifyContent: 'space-between'`):
//      Em telas mobile estreitas, nomes de times com tamanhos diferentes
//      (ex.: "G2" vs "Natus Vincere") costumam deslocar o placar do centro real.
//      Atribuímos `flex: 1` para cada bloco de time (esquerdo com `flex-start`
//      e direito com `flex-end`) e largura fixa/centralizada para o bloco do
//      placar central — garantindo que o placar/VS fique geometricamente cravado
//      no centro do card como no Apple Sports.
//   2. Dimensões Fixas de Imagem (`width: 48, height: 48` + `resizeMode="contain"`):
//      Evita "layout shift" (pulo visual) enquanto os logotipos carregam pela
//      rede e mantém o alinhamento vertical idêntico mesmo quando um time usa
//      logo e o adversário cai no fallback textual da sigla.
//   3. `React.memo`: Na Home Screen, uma `FlatList` pode conter dezenas de cards.
//      Envolver `MatchCard` em `React.memo` evita que cards inalterados sofram
//      re-renderização durante o Pull-to-Refresh ou atualizações pontuais.
// =============================================================================
import React, { memo, useEffect, useState } from 'react';
// [UPDATE]: Importa `Image` do React Native para renderizar os escudos dos times.
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MatchCardDto, MatchTeamSummary } from '../types/match';

export interface MatchCardProps {
  match: MatchCardDto;
  // [UPDATE]: Módulo 8 — Callback disparado ao tocar no card para abrir a `LiveMatchScreen`.
  onPress?: (match: MatchCardDto) => void;
}

/**
 * [UPDATE]: Analisa a data/hora da partida (`scheduled_at` / `beginAt`) e
 * identifica se o confronto ocorre no dia atual (Hoje) no fuso local do usuário.
 */
interface FormattedSchedule {
  isToday: boolean;
  dateLabel: string;
  timeLabel: string;
}

function formatMatchSchedule(isoDate: string): FormattedSchedule {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return {
      isToday: false,
      dateLabel: '--/--',
      timeLabel: '--:--',
    };
  }

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const timeLabel = `${hours}:${minutes}`;

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const dateLabel = `${day}/${month}`;

  return {
    isToday,
    dateLabel,
    timeLabel,
  };
}

/**
 * [UPDATE]: Determina a sigla de fallback caso `logo_url` seja nulo ou falhe ao
 * carregar. Se a equipe existir mas não tiver `acronym` cadastrado na API,
 * extrai as 3 primeiras letras do nome para não exibir "TBD" indevidamente.
 */
function resolveTeamFallbackAcronym(team: MatchTeamSummary | null): string {
  if (!team) return 'TBD';
  const trimmedAcronym = team.acronym?.trim();
  if (trimmedAcronym) return trimmedAcronym;
  const trimmedName = team.name?.trim();
  if (trimmedName) return trimmedName.slice(0, 3).toUpperCase();
  return 'TBD';
}

function MatchCardComponent({ match, onPress }: MatchCardProps): React.JSX.Element {
  const isLive = match.status === 'live';
  const isFinished = match.status === 'finished';

  // [UPDATE]: Controla falhas de carregamento HTTP de cada logo (`onError`) para
  // acionar automaticamente o fallback textual da sigla sem quebrar o card.
  const [teamALogoError, setTeamALogoError] = useState<boolean>(false);
  const [teamBLogoError, setTeamBLogoError] = useState<boolean>(false);

  const teamALogoUrl = match.team_a?.logo_url?.trim() || null;
  const teamBLogoUrl = match.team_b?.logo_url?.trim() || null;

  useEffect(() => {
    setTeamALogoError(false);
  }, [teamALogoUrl]);

  useEffect(() => {
    setTeamBLogoError(false);
  }, [teamBLogoUrl]);

  const teamAAcronym = resolveTeamFallbackAcronym(match.team_a);
  const teamAName = match.team_a?.name ?? 'A definir';
  const teamBAcronym = resolveTeamFallbackAcronym(match.team_b);
  const teamBName = match.team_b?.name ?? 'A definir';

  const schedule = formatMatchSchedule(match.scheduled_at);
  const showTeamALogo = Boolean(teamALogoUrl) && !teamALogoError;
  const showTeamBLogo = Boolean(teamBLogoUrl) && !teamBLogoError;

  // [UPDATE]: Lê exatamente `match.results` (mesma fonte oficial do `PostMatchSummary`)
  // para evitar qualquer divergência de placar entre a Home e a tela de Detalhes.
  const targetWins = match.format === 'BO1' ? 1 : match.format === 'BO5' ? 3 : 2;
  const teamAScore =
    match.results?.team_a_score ??
    (isFinished && match.winner_id === match.team_a?.id ? targetWins : 0);
  const teamBScore =
    match.results?.team_b_score ??
    (isFinished && match.winner_id === match.team_b?.id ? targetWins : 0);

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
      {/* Topo do Card: Nome do Campeonato (esquerda) + Status/Data/Hora (direita) */}
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
        ) : isFinished ? (
          <Text style={styles.statusText}>{schedule.dateLabel} • ENCERRADO</Text>
        ) : schedule.isToday ? (
          // [UPDATE]: Destaque verde (#22c55e) para partidas que acontecem Hoje.
          <Text style={styles.statusText}>
            <Text style={styles.todayText}>Hoje</Text>
            <Text style={styles.statusText}> • {schedule.timeLabel}</Text>
          </Text>
        ) : (
          // [UPDATE]: Exibe data (DD/MM) + horário para partidas de outros dias.
          <Text style={styles.statusText}>
            {schedule.dateLabel} • {schedule.timeLabel}
          </Text>
        )}
      </View>

      {/* Corpo Principal: Time A (Logo + Nome) | Placar/VS Central | Time B (Logo + Nome) */}
      <View style={styles.matchupRow}>
        {/* Coluna Esquerda (Time A) — `flex: 1` mantém simetria com o lado direito */}
        <View style={styles.teamColumnLeft}>
          <View style={styles.logoSlot}>
            {showTeamALogo && teamALogoUrl ? (
              <Image
                source={{ uri: teamALogoUrl }}
                style={styles.teamLogo}
                resizeMode="contain"
                onError={() => setTeamALogoError(true)}
              />
            ) : (
              <Text style={styles.teamAcronymFallback} numberOfLines={1}>
                {teamAAcronym}
              </Text>
            )}
          </View>
          <Text style={styles.teamFullNameLeft} numberOfLines={1}>
            {teamAName}
          </Text>
        </View>

        {/* Bloco Central — Placar em destaque ou "VS" para jogos futuros */}
        <View style={styles.scoreCenterBox}>
          {isLive || isFinished ? (
            <View style={styles.scoreNumbersRow}>
              <Text style={styles.scoreNumber}>{teamAScore}</Text>
              <Text style={styles.scoreSeparator}>-</Text>
              <Text style={styles.scoreNumber}>{teamBScore}</Text>
            </View>
          ) : (
            <Text style={styles.versusLabel}>VS</Text>
          )}
          <Text style={styles.formatSubLabel}>{match.format}</Text>
        </View>

        {/* Coluna Direita (Time B) — `flex: 1` + alinhamento à direita */}
        <View style={styles.teamColumnRight}>
          <View style={styles.logoSlotRight}>
            {showTeamBLogo && teamBLogoUrl ? (
              <Image
                source={{ uri: teamBLogoUrl }}
                style={styles.teamLogo}
                resizeMode="contain"
                onError={() => setTeamBLogoError(true)}
              />
            ) : (
              <Text style={styles.teamAcronymFallback} numberOfLines={1}>
                {teamBAcronym}
              </Text>
            )}
          </View>
          <Text style={styles.teamFullNameRight} numberOfLines={1}>
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
    letterSpacing: 0.4,
  },
  // [UPDATE]: Estilo verde (#22c55e) em negrito para destacar jogos que ocorrem "Hoje".
  todayText: {
    color: '#22c55e',
    fontWeight: 'bold',
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
  // [UPDATE]: Slot de altura fixa (48px) mantém simetria vertical entre logo e fallback de sigla.
  logoSlot: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  logoSlotRight: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'flex-end',
    marginBottom: 6,
  },
  // [UPDATE]: Dimensões fixas 48x48 para o escudo da equipe.
  teamLogo: {
    width: 48,
    height: 48,
  },
  teamAcronymFallback: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  teamFullNameLeft: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'left',
  },
  teamFullNameRight: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'right',
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
