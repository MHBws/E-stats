// =============================================================================
// mobile/src/components/PreMatchStats.tsx — Interface de Pré-Jogo (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Renderiza os detalhes de uma partida agendada (`status === 'scheduled'`
//        ou `'not_started'`), exibindo:
//          1. Cabeçalho do confronto com escudos das equipes, data/hora agendada
//             e contador regressivo em tempo real.
//          2. Elencos (Rosters) das duas equipes lado a lado em duas colunas,
//             com foto/avatar (`image_url`), nickname e nacionalidade.
//          3. Resumo do formato da série e mapas previstos.
//
// POR QUE:
//   - Evita abrir conexões WebSocket desnecessárias antes do início do jogo.
//   - Mantém a estética Dark Mode OLED (`#000000` / `#1C1C1E` / `#2C2C2E`) e
//     usa `flex: 1` simétrico nas duas colunas de roster para alinhamento perfeito.
// =============================================================================
import React, { memo, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  MatchDetailDto,
  MatchRosterPlayerDto,
  MatchTeamSummary,
} from '../types/match';

export interface PreMatchStatsProps {
  match: MatchDetailDto;
}

/** Formata a data e o horário agendado (`DD/MM/YYYY • HH:mm`). */
function formatScheduledDateTime(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return 'Horário a definir';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} • ${hours}:${minutes}`;
}

/** Calcula o texto do contador regressivo até o início da partida. */
function formatCountdown(isoDate: string, nowMs: number): string {
  const targetMs = new Date(isoDate).getTime();
  if (Number.isNaN(targetMs)) return 'AGUARDANDO HORÁRIO';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'PRESTES A COMEÇAR';

  const totalSeconds = Math.floor(diffMs / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `COMEÇA EM ${days}D ${String(hours).padStart(2, '0')}H ${String(minutes).padStart(2, '0')}M`;
  }
  return `COMEÇA EM ${String(hours).padStart(2, '0')}H ${String(minutes).padStart(2, '0')}M ${String(seconds).padStart(2, '0')}S`;
}

function resolveTeamAcronym(team: MatchTeamSummary | null): string {
  if (!team) return 'TBD';
  if (team.acronym?.trim()) return team.acronym.trim();
  if (team.name?.trim()) return team.name.trim().slice(0, 3).toUpperCase();
  return 'TBD';
}

interface RosterPlayerItemProps {
  player: MatchRosterPlayerDto;
  align: 'left' | 'right';
}

const RosterPlayerItem = memo(function RosterPlayerItem({
  player,
  align,
}: RosterPlayerItemProps): React.JSX.Element {
  const [imgError, setImgError] = useState<boolean>(false);
  const hasImage = Boolean(player.image_url?.trim()) && !imgError;
  const initials = player.nickname.slice(0, 2).toUpperCase();

  return (
    <View
      style={[
        styles.playerCardRow,
        align === 'right' && styles.playerCardRowRight,
      ]}
    >
      <View style={styles.avatarContainer}>
        {hasImage && player.image_url ? (
          <Image
            source={{ uri: player.image_url }}
            style={styles.playerAvatar}
            resizeMode="cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <Text style={styles.avatarFallbackText}>{initials}</Text>
        )}
      </View>

      <View
        style={[
          styles.playerInfoBox,
          align === 'right' && styles.playerInfoBoxRight,
        ]}
      >
        <Text style={styles.playerNickText} numberOfLines={1}>
          {player.nickname}
        </Text>
        <Text style={styles.playerMetaText} numberOfLines={1}>
          {player.nationality ?? 'CS2'}
          {player.age ? ` · ${player.age}a` : ''}
        </Text>
      </View>
    </View>
  );
});

function PreMatchStatsComponent({ match }: PreMatchStatsProps): React.JSX.Element {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [logoAError, setLogoAError] = useState<boolean>(false);
  const [logoBError, setLogoBError] = useState<boolean>(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const teamALogo = match.team_a?.logo_url?.trim() || null;
  const teamBLogo = match.team_b?.logo_url?.trim() || null;
  const teamARoster = match.team_a?.players ?? [];
  const teamBRoster = match.team_b?.players ?? [];

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      {/* Bloco 1: Cabeçalho do Confronto + Contador Regressivo */}
      <View style={styles.headerCard}>
        <Text style={styles.tournamentLabel} numberOfLines={1}>
          {match.tournament.name}
          {match.tournament.tier ? ` · Tier ${match.tournament.tier}` : ''}
        </Text>

        <View style={styles.teamsRow}>
          {/* Time A */}
          <View style={styles.teamBlock}>
            <View style={styles.logoBox}>
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
              {match.team_a?.name ?? 'A definir'}
            </Text>
          </View>

          {/* Centro: VS + Formato */}
          <View style={styles.centerVsBlock}>
            <Text style={styles.vsBadgeText}>VS</Text>
            <Text style={styles.formatPillText}>{match.format}</Text>
          </View>

          {/* Time B */}
          <View style={styles.teamBlock}>
            <View style={styles.logoBox}>
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
              {match.team_b?.name ?? 'A definir'}
            </Text>
          </View>
        </View>

        <View style={styles.scheduleFooter}>
          <View style={styles.countdownBadge}>
            <Text style={styles.countdownText}>
              {formatCountdown(match.scheduled_at, nowMs)}
            </Text>
          </View>
          <Text style={styles.scheduledDateText}>
            {formatScheduledDateTime(match.scheduled_at)}
          </Text>
        </View>
      </View>

      {/* Bloco 2: Elencos (Rosters) Lado a Lado em Duas Colunas */}
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>ELENCOS (ROSTERS)</Text>

        <View style={styles.rostersColumnsHeader}>
          <Text style={styles.rosterTeamTitleLeft} numberOfLines={1}>
            {match.team_a?.name ?? 'Equipe A'}
          </Text>
          <Text style={styles.rosterTeamTitleRight} numberOfLines={1}>
            {match.team_b?.name ?? 'Equipe B'}
          </Text>
        </View>

        {teamARoster.length === 0 && teamBRoster.length === 0 ? (
          <Text style={styles.emptyRosterText}>
            Elencos ainda não divulgados oficialmente para esta série.
          </Text>
        ) : (
          <View style={styles.rostersTwoColumns}>
            <View style={styles.rosterColumnLeft}>
              {teamARoster.map((player) => (
                <RosterPlayerItem
                  key={player.id}
                  player={player}
                  align="left"
                />
              ))}
            </View>

            <View style={styles.rosterVerticalDivider} />

            <View style={styles.rosterColumnRight}>
              {teamBRoster.map((player) => (
                <RosterPlayerItem
                  key={player.id}
                  player={player}
                  align="right"
                />
              ))}
            </View>
          </View>
        )}
      </View>

      {/* Bloco 3: Estrutura da Série / Mapas */}
      <View style={styles.sectionCard}>
        <Text style={styles.sectionTitle}>FORMATO DA SÉRIE ({match.format})</Text>
        <Text style={styles.seriesDescriptionText}>
          O veto oficial de mapas será liberado momentos antes do início da partida.
        </Text>
      </View>
    </ScrollView>
  );
}

export const PreMatchStats = memo(PreMatchStatsComponent);

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 40,
  },
  headerCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 18,
    padding: 18,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C2C2E',
    alignItems: 'center',
  },
  tournamentLabel: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center',
  },
  teamsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  teamBlock: {
    flex: 1,
    alignItems: 'center',
  },
  logoBox: {
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
  centerVsBlock: {
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  vsBadgeText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 1,
  },
  formatPillText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  scheduleFooter: {
    marginTop: 18,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2C2C2E',
    width: '100%',
    alignItems: 'center',
  },
  countdownBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.14)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    marginBottom: 6,
  },
  countdownText: {
    color: '#22c55e',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    fontVariant: ['tabular-nums'],
  },
  scheduledDateText: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
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
  rostersColumnsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  rosterTeamTitleLeft: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'left',
  },
  rosterTeamTitleRight: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'right',
  },
  rostersTwoColumns: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rosterColumnLeft: {
    flex: 1,
    paddingRight: 8,
  },
  rosterColumnRight: {
    flex: 1,
    paddingLeft: 8,
  },
  rosterVerticalDivider: {
    width: 1,
    backgroundColor: '#2C2C2E',
  },
  playerCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  playerCardRowRight: {
    flexDirection: 'row-reverse',
  },
  avatarContainer: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#2C2C2E',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playerAvatar: {
    width: 34,
    height: 34,
  },
  avatarFallbackText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  playerInfoBox: {
    flex: 1,
    marginLeft: 10,
  },
  playerInfoBoxRight: {
    marginLeft: 0,
    marginRight: 10,
    alignItems: 'flex-end',
  },
  playerNickText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  playerMetaText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },
  emptyRosterText: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 12,
  },
  seriesDescriptionText: {
    color: '#8E8E93',
    fontSize: 12,
    lineHeight: 18,
  },
});
