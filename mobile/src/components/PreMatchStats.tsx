// =============================================================================
// mobile/src/components/PreMatchStats.tsx — Pré-Jogo Estilo Sofascore / Apple Sports
// -----------------------------------------------------------------------------
// [UPDATE]: Revoluciona a tela de pré-jogo (`status === 'scheduled' | 'not_started'`)
//           adicionando navegação horizontal interna por 3 abas ("Detalhes",
//           "Classificações" e "Partidas") alimentadas pelos dados reais de
//           `match.preMatchStats` vindos da PandaScore via BFF:
//             1. Aba "Detalhes":
//                - H2H pré-jogo (balanço de vitórias/empates + barra proporcional).
//                - Desempenho da equipa / Form (últimos 5 jogos com badges verdes/vermelhos
//                  exibindo o placar exato, ex.: "2-0", "1-2").
//                - Onde assistir (lista clicável de canais Twitch/YouTube/Kick com
//                  bandeira/idioma via `Linking.openURL`).
//                - Elencos (Rosters) das duas equipas lado a lado.
//             2. Aba "Classificações":
//                - Tabela do grupo/torneio com colunas `#`, `Equipa`, `P` e `W-L`,
//                  destacando visualmente as linhas das duas equipas do confronto.
//             3. Aba "Partidas":
//                - Resumo "Confrontos diretos" com total de vitórias de cada lado
//                  seguido por `FlatList` nativa (sem aninhamento em `ScrollView`)
//                  listando data, torneio e placar final dos duelos históricos.
//
// POR QUE:
//   - Evita conexões WebSocket ociosas em partidas que ainda não começaram.
//   - Segue rigorosamente o tema Dark Mode OLED (`#000000` / `#1C1C1E` / `#2C2C2E`)
//     e usa `FlatList` de nível raiz na aba "Partidas" para eliminar warnings de
//     `VirtualizedLists` aninhadas no React Native.
// =============================================================================
import React, { memo, useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import type {
  MatchDetailDto,
  MatchRosterPlayerDto,
  MatchTeamSummary,
  PreMatchH2HMatchDto,
  PreMatchH2HSummaryDto,
  PreMatchStandingRowDto,
  PreMatchStreamDto,
  PreMatchTeamFormEntryDto,
} from '../types/match';

export interface PreMatchStatsProps {
  match: MatchDetailDto;
}

type PreMatchTabKey = 'details' | 'standings' | 'matches';

interface TabDefinition {
  key: PreMatchTabKey;
  label: string;
}

const PRE_MATCH_TABS: readonly TabDefinition[] = [
  { key: 'details', label: 'Detalhes' },
  { key: 'standings', label: 'Classificações' },
  { key: 'matches', label: 'Partidas' },
] as const;

const EMPTY_H2H: PreMatchH2HSummaryDto = {
  team_a_wins: 0,
  team_b_wins: 0,
  draws: 0,
  total_matches: 0,
  matches: [],
};

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

/** Formata uma data histórica ISO em `DD/MM/YYYY`. */
function formatShortDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
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
  if (team.acronym?.trim()) return team.acronym.trim().toUpperCase();
  if (team.name?.trim()) return team.name.trim().slice(0, 3).toUpperCase();
  return 'TBD';
}

function resolvePlatformBadge(platform: PreMatchStreamDto['platform']): {
  label: string;
  bgColor: string;
  textColor: string;
} {
  switch (platform) {
    case 'twitch':
      return {
        label: 'TWITCH',
        bgColor: 'rgba(145, 70, 255, 0.20)',
        textColor: '#B98EFF',
      };
    case 'youtube':
      return {
        label: 'YOUTUBE',
        bgColor: 'rgba(255, 69, 58, 0.20)',
        textColor: '#FF6961',
      };
    case 'kick':
      return {
        label: 'KICK',
        bgColor: 'rgba(83, 252, 24, 0.16)',
        textColor: '#53FC18',
      };
    default:
      return {
        label: 'LIVE',
        bgColor: 'rgba(10, 132, 255, 0.20)',
        textColor: '#5AC8FA',
      };
  }
}

// =============================================================================
// Subcomponente reutilizável de Mini Logo com Fallback de Sigla
// =============================================================================
interface MiniTeamLogoProps {
  logoUrl: string | null | undefined;
  fallbackAcronym: string;
  size?: number;
}

const MiniTeamLogo = memo(function MiniTeamLogo({
  logoUrl,
  fallbackAcronym,
  size = 24,
}: MiniTeamLogoProps): React.JSX.Element {
  const [hasError, setHasError] = useState<boolean>(false);
  const validUri = logoUrl?.trim() || null;

  if (validUri && !hasError) {
    return (
      <Image
        source={{ uri: validUri }}
        style={{ width: size, height: size }}
        resizeMode="contain"
        onError={() => setHasError(true)}
      />
    );
  }

  return (
    <View
      style={[
        styles.miniLogoFallbackBox,
        { width: size, height: size, borderRadius: Math.round(size / 2) },
      ]}
    >
      <Text style={styles.miniLogoFallbackText} numberOfLines={1}>
        {fallbackAcronym.slice(0, 3).toUpperCase()}
      </Text>
    </View>
  );
});

// =============================================================================
// Cabeçalho Principal da Partida + Barra de Abas Horizontais
// =============================================================================
interface PreMatchTopSectionProps {
  match: MatchDetailDto;
  nowMs: number;
  activeTab: PreMatchTabKey;
  onSelectTab: (tab: PreMatchTabKey) => void;
}

const PreMatchTopSection = memo(function PreMatchTopSection({
  match,
  nowMs,
  activeTab,
  onSelectTab,
}: PreMatchTopSectionProps): React.JSX.Element {
  const [logoAError, setLogoAError] = useState<boolean>(false);
  const [logoBError, setLogoBError] = useState<boolean>(false);

  const teamALogo = match.team_a?.logo_url?.trim() || null;
  const teamBLogo = match.team_b?.logo_url?.trim() || null;

  return (
    <View>
      {/* Card Superior: Confronto + Contador Regressivo */}
      <View style={styles.headerCard}>
        <Text style={styles.tournamentLabel} numberOfLines={1}>
          {match.tournament.name}
          {match.tournament.tier ? ` · Tier ${match.tournament.tier}` : ''}
        </Text>

        <View style={styles.teamsRow}>
          {/* Equipa A */}
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

          {/* Equipa B */}
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

      {/* Navegação Horizontal por Abas ("Detalhes" | "Classificações" | "Partidas") */}
      <View style={styles.tabBarContainer}>
        {PRE_MATCH_TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onSelectTab(tab.key)}
              style={[styles.tabButton, isActive && styles.tabButtonActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                style={[styles.tabButtonText, isActive && styles.tabButtonTextActive]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});

// =============================================================================
// Subcomponentes da Aba 1 ("Detalhes"): H2H, Desempenho (Form), Streams e Rosters
// =============================================================================
interface H2HBalanceSummaryProps {
  h2h: PreMatchH2HSummaryDto;
  teamA: MatchTeamSummary | null;
  teamB: MatchTeamSummary | null;
  title: string;
}

const H2HBalanceSummaryCard = memo(function H2HBalanceSummaryCard({
  h2h,
  teamA,
  teamB,
  title,
}: H2HBalanceSummaryProps): React.JSX.Element {
  const total = h2h.total_matches;
  const flexA = total > 0 ? Math.max(h2h.team_a_wins, 0.15) : 1;
  const flexDraws = total > 0 && h2h.draws > 0 ? Math.max(h2h.draws, 0.15) : 0;
  const flexB = total > 0 ? Math.max(h2h.team_b_wins, 0.15) : 1;

  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitleInline}>{title}</Text>
        <Text style={styles.sectionMetaRight}>
          {total > 0
            ? `Últimos ${total} ${total === 1 ? 'confronto' : 'confrontos'}`
            : 'Sem histórico recente'}
        </Text>
      </View>

      <View style={styles.h2hCountersRow}>
        {/* Vitórias Equipa A */}
        <View style={styles.h2hCounterBlock}>
          <View style={styles.h2hTeamLabelRow}>
            <MiniTeamLogo
              logoUrl={teamA?.logo_url}
              fallbackAcronym={resolveTeamAcronym(teamA)}
              size={22}
            />
            <Text style={styles.h2hTeamCodeText} numberOfLines={1}>
              {resolveTeamAcronym(teamA)}
            </Text>
          </View>
          <Text style={[styles.h2hBigCountText, styles.h2hTeamAAccent]}>
            {h2h.team_a_wins}
          </Text>
          <Text style={styles.h2hSubLabelText}>Vitórias</Text>
        </View>

        {/* Empates */}
        <View style={styles.h2hCounterBlockCenter}>
          <Text style={styles.h2hDrawCountText}>{h2h.draws}</Text>
          <Text style={styles.h2hSubLabelText}>Empates</Text>
        </View>

        {/* Vitórias Equipa B */}
        <View style={styles.h2hCounterBlockRight}>
          <View style={styles.h2hTeamLabelRow}>
            <Text style={styles.h2hTeamCodeText} numberOfLines={1}>
              {resolveTeamAcronym(teamB)}
            </Text>
            <MiniTeamLogo
              logoUrl={teamB?.logo_url}
              fallbackAcronym={resolveTeamAcronym(teamB)}
              size={22}
            />
          </View>
          <Text style={[styles.h2hBigCountText, styles.h2hTeamBAccent]}>
            {h2h.team_b_wins}
          </Text>
          <Text style={styles.h2hSubLabelText}>Vitórias</Text>
        </View>
      </View>

      {/* Barra proporcional estilo Sofascore */}
      <View style={styles.h2hBarTrack}>
        <View
          style={[
            styles.h2hBarSegmentA,
            { flex: flexA },
            total === 0 && styles.h2hBarSegmentNeutral,
          ]}
        />
        {flexDraws > 0 ? (
          <View style={[styles.h2hBarSegmentDraw, { flex: flexDraws }]} />
        ) : null}
        <View
          style={[
            styles.h2hBarSegmentB,
            { flex: flexB },
            total === 0 && styles.h2hBarSegmentNeutralRight,
          ]}
        />
      </View>
    </View>
  );
});

interface FormRowProps {
  team: MatchTeamSummary | null;
  entries: PreMatchTeamFormEntryDto[];
}

const TeamFormRow = memo(function TeamFormRow({
  team,
  entries,
}: FormRowProps): React.JSX.Element {
  // Garante sempre 5 slots visuais alinhados (preenchendo com `null` se houver < 5 jogos).
  const slots: Array<PreMatchTeamFormEntryDto | null> = Array.from(
    { length: 5 },
    (_, idx) => entries[idx] ?? null,
  );

  return (
    <View style={styles.formTeamRow}>
      <View style={styles.formTeamIdentity}>
        <MiniTeamLogo
          logoUrl={team?.logo_url}
          fallbackAcronym={resolveTeamAcronym(team)}
          size={24}
        />
        <Text style={styles.formTeamNameText} numberOfLines={1}>
          {team?.name ?? resolveTeamAcronym(team)}
        </Text>
      </View>

      <View style={styles.formBadgesRow}>
        {slots.map((entry, idx) => {
          if (!entry) {
            return (
              <View key={`empty-${idx}`} style={[styles.formBadge, styles.formBadgeEmpty]}>
                <Text style={styles.formBadgeEmptyText}>—</Text>
              </View>
            );
          }

          const badgeVariantStyle =
            entry.outcome === 'W'
              ? styles.formBadgeWin
              : entry.outcome === 'L'
                ? styles.formBadgeLoss
                : styles.formBadgeDraw;

          return (
            <View
              key={`${entry.match_id}-${idx}`}
              style={[styles.formBadge, badgeVariantStyle]}
            >
              <Text style={styles.formBadgeScoreText} numberOfLines={1}>
                {entry.score_label}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
});

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

// =============================================================================
// Subcomponente da Aba 2 ("Classificações"): Tabela do Torneio / Grupo
// =============================================================================
interface StandingsRowItemProps {
  row: PreMatchStandingRowDto;
  isLast: boolean;
}

const StandingsRowItem = memo(function StandingsRowItem({
  row,
  isLast,
}: StandingsRowItemProps): React.JSX.Element {
  const isHighlighted = row.is_team_a || row.is_team_b;
  const fallbackCode =
    row.team_acronym?.trim() || row.team_name.slice(0, 3).toUpperCase();

  return (
    <View
      style={[
        styles.standingsRow,
        !isLast && styles.standingsRowDivider,
        row.is_team_a && styles.standingsRowHighlightA,
        row.is_team_b && styles.standingsRowHighlightB,
      ]}
    >
      <Text
        style={[
          styles.standingsColRank,
          isHighlighted && styles.standingsTextHighlighted,
        ]}
      >
        {row.rank}
      </Text>

      <View style={styles.standingsColTeam}>
        <MiniTeamLogo
          logoUrl={row.team_logo_url}
          fallbackAcronym={fallbackCode}
          size={22}
        />
        <Text
          style={[
            styles.standingsTeamName,
            isHighlighted && styles.standingsTextHighlighted,
          ]}
          numberOfLines={1}
        >
          {row.team_name}
        </Text>
      </View>

      <Text
        style={[
          styles.standingsColPoints,
          isHighlighted && styles.standingsTextHighlighted,
        ]}
      >
        {row.points}
      </Text>

      <Text
        style={[
          styles.standingsColWL,
          isHighlighted && styles.standingsWLHighlighted,
        ]}
      >
        {row.wins}-{row.losses}
      </Text>
    </View>
  );
});

// =============================================================================
// Subcomponente da Aba 3 ("Partidas"): Item do Histórico de Confrontos Diretos
// =============================================================================
interface H2HMatchCardProps {
  item: PreMatchH2HMatchDto;
}

const H2HMatchHistoryItem = memo(function H2HMatchHistoryItem({
  item,
}: H2HMatchCardProps): React.JSX.Element {
  const teamAWon = item.winner_side === 'team_a';
  const teamBWon = item.winner_side === 'team_b';

  return (
    <View style={styles.h2hMatchItemCard}>
      <View style={styles.h2hMatchMetaHeader}>
        <Text style={styles.h2hMatchDateText}>{formatShortDate(item.date)}</Text>
        <Text style={styles.h2hMatchTournamentText} numberOfLines={1}>
          {item.tournament_name}
        </Text>
      </View>

      <View style={styles.h2hMatchScoreRow}>
        <Text
          style={[
            styles.h2hMatchTeamLeft,
            teamAWon ? styles.h2hMatchWinnerText : styles.h2hMatchLoserText,
          ]}
          numberOfLines={1}
        >
          {item.team_a_name}
        </Text>

        <View style={styles.h2hMatchScorePill}>
          <Text
            style={[
              styles.h2hMatchScoreNumber,
              teamAWon && styles.h2hMatchScoreWinnerA,
            ]}
          >
            {item.team_a_score}
          </Text>
          <Text style={styles.h2hMatchScoreSeparator}>-</Text>
          <Text
            style={[
              styles.h2hMatchScoreNumber,
              teamBWon && styles.h2hMatchScoreWinnerB,
            ]}
          >
            {item.team_b_score}
          </Text>
        </View>

        <Text
          style={[
            styles.h2hMatchTeamRight,
            teamBWon ? styles.h2hMatchWinnerText : styles.h2hMatchLoserText,
          ]}
          numberOfLines={1}
        >
          {item.team_b_name}
        </Text>
      </View>
    </View>
  );
});

// =============================================================================
// Componente Principal `<PreMatchStats />`
// =============================================================================
function PreMatchStatsComponent({ match }: PreMatchStatsProps): React.JSX.Element {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [activeTab, setActiveTab] = useState<PreMatchTabKey>('details');

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const preMatch = match.preMatchStats;
  const h2h = preMatch?.h2h ?? EMPTY_H2H;
  const formTeamA = preMatch?.recent_form.team_a ?? [];
  const formTeamB = preMatch?.recent_form.team_b ?? [];
  const standings = preMatch?.standings ?? [];
  const streams = preMatch?.streams ?? [];
  const teamARoster = match.team_a?.players ?? [];
  const teamBRoster = match.team_b?.players ?? [];

  const handleOpenStream = useCallback((url: string) => {
    if (!url) return;
    Linking.openURL(url).catch(() => {
      // Silencia falha caso o emulador não possua handler para o esquema da URL.
    });
  }, []);

  const renderH2HItem = useCallback(
    ({ item }: ListRenderItemInfo<PreMatchH2HMatchDto>) => (
      <H2HMatchHistoryItem item={item} />
    ),
    [],
  );

  const keyExtractorH2H = useCallback(
    (item: PreMatchH2HMatchDto) => item.id,
    [],
  );

  // ---------------------------------------------------------------------------
  // ABA 3 ("Partidas") — Renderizada via `FlatList` raiz para máxima fluidez
  // ---------------------------------------------------------------------------
  if (activeTab === 'matches') {
    return (
      <FlatList
        data={h2h.matches}
        keyExtractor={keyExtractorH2H}
        renderItem={renderH2HItem}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            <PreMatchTopSection
              match={match}
              nowMs={nowMs}
              activeTab={activeTab}
              onSelectTab={setActiveTab}
            />
            <H2HBalanceSummaryCard
              h2h={h2h}
              teamA={match.team_a}
              teamB={match.team_b}
              title="CONFRONTOS DIRETOS"
            />
            {h2h.matches.length > 0 ? (
              <Text style={styles.listSectionLabel}>HISTÓRICO DE PARTIDAS</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.sectionCard}>
            <Text style={styles.emptySectionText}>
              Nenhum confronto direto anterior encontrado entre{' '}
              {match.team_a?.name ?? 'Equipa A'} e {match.team_b?.name ?? 'Equipa B'}.
            </Text>
          </View>
        }
      />
    );
  }

  // ---------------------------------------------------------------------------
  // ABAS 1 ("Detalhes") e 2 ("Classificações") — Renderizadas em `ScrollView`
  // ---------------------------------------------------------------------------
  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <PreMatchTopSection
        match={match}
        nowMs={nowMs}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
      />

      {activeTab === 'details' ? (
        <View>
          {/* 1. H2H Pré-Jogo */}
          <H2HBalanceSummaryCard
            h2h={h2h}
            teamA={match.team_a}
            teamB={match.team_b}
            title="H2H PRÉ-JOGO"
          />

          {/* 2. Desempenho da Equipa (Últimos 5 Jogos / Form) */}
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitleInline}>DESEMPENHO DA EQUIPA</Text>
              <Text style={styles.sectionMetaRight}>Últimos 5 jogos</Text>
            </View>

            <TeamFormRow team={match.team_a} entries={formTeamA} />
            <View style={styles.formRowsDivider} />
            <TeamFormRow team={match.team_b} entries={formTeamB} />
          </View>

          {/* 3. Onde Assistir (Streams com Bandeira/Idioma) */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>ONDE ASSISTIR</Text>

            {streams.length === 0 ? (
              <Text style={styles.emptySectionText}>
                Canais de transmissão serão listados próximo ao início da partida.
              </Text>
            ) : (
              streams.map((stream, index) => {
                const platformBadge = resolvePlatformBadge(stream.platform);
                const isLast = index === streams.length - 1;
                return (
                  <Pressable
                    key={`${stream.url}-${index}`}
                    onPress={() => handleOpenStream(stream.url)}
                    style={({ pressed }) => [
                      styles.streamRow,
                      !isLast && styles.streamRowDivider,
                      pressed && styles.streamRowPressed,
                    ]}
                  >
                    <View style={styles.streamLeftInfo}>
                      <Text style={styles.streamFlagText}>{stream.flag_emoji}</Text>
                      <View style={styles.streamTextBlock}>
                        <View style={styles.streamChannelTitleRow}>
                          <Text style={styles.streamChannelName} numberOfLines={1}>
                            {stream.channel_name}
                          </Text>
                          {stream.is_official ? (
                            <View style={styles.officialBadge}>
                              <Text style={styles.officialBadgeText}>OFICIAL</Text>
                            </View>
                          ) : null}
                        </View>
                        <Text style={styles.streamLangMeta}>
                          Idioma: {stream.language.toUpperCase()}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.streamRightBox}>
                      <View
                        style={[
                          styles.platformPill,
                          { backgroundColor: platformBadge.bgColor },
                        ]}
                      >
                        <Text
                          style={[
                            styles.platformPillText,
                            { color: platformBadge.textColor },
                          ]}
                        >
                          {platformBadge.label}
                        </Text>
                      </View>
                      <Text style={styles.streamChevron}>↗</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>

          {/* 4. Elencos (Rosters) Lado a Lado */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>ELENCOS (ROSTERS)</Text>

            <View style={styles.rostersColumnsHeader}>
              <Text style={styles.rosterTeamTitleLeft} numberOfLines={1}>
                {match.team_a?.name ?? 'Equipa A'}
              </Text>
              <Text style={styles.rosterTeamTitleRight} numberOfLines={1}>
                {match.team_b?.name ?? 'Equipa B'}
              </Text>
            </View>

            {teamARoster.length === 0 && teamBRoster.length === 0 ? (
              <Text style={styles.emptySectionText}>
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
        </View>
      ) : (
        /* ABA 2 ("Classificações") — Tabela do Grupo / Torneio */
        <View style={styles.sectionCard}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitleInline}>CLASSIFICAÇÃO DO TORNEIO</Text>
            <Text style={styles.sectionMetaRight} numberOfLines={1}>
              {match.tournament.name}
            </Text>
          </View>

          {standings.length === 0 ? (
            <Text style={styles.emptySectionText}>
              Tabela de classificação indisponível para a fase atual deste torneio.
            </Text>
          ) : (
            <View>
              {/* Cabeçalho das colunas: #, Equipa, P, W-L */}
              <View style={styles.standingsHeaderRow}>
                <Text style={[styles.standingsHeaderLabel, styles.standingsColRank]}>
                  #
                </Text>
                <Text style={[styles.standingsHeaderLabel, styles.standingsColTeamHeader]}>
                  EQUIPA
                </Text>
                <Text style={[styles.standingsHeaderLabel, styles.standingsColPoints]}>
                  P
                </Text>
                <Text style={[styles.standingsHeaderLabel, styles.standingsColWL]}>
                  W-L
                </Text>
              </View>

              {standings.map((row, index) => (
                <StandingsRowItem
                  key={`${row.rank}-${row.team_name}`}
                  row={row}
                  isLast={index === standings.length - 1}
                />
              ))}
            </View>
          )}
        </View>
      )}
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
  // Barra de Abas Horizontais ("Detalhes" | "Classificações" | "Partidas")
  tabBarContainer: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1E',
    borderRadius: 14,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  tabButton: {
    flex: 1,
    paddingVertical: 9,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#2C2C2E',
  },
  tabButtonText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '700',
  },
  tabButtonTextActive: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  // Cards de Seção
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
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sectionTitleInline: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
  },
  sectionMetaRight: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
    maxWidth: '50%',
  },
  emptySectionText: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 10,
    lineHeight: 19,
  },
  miniLogoFallbackBox: {
    backgroundColor: '#2C2C2E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniLogoFallbackText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '800',
  },
  // H2H Pré-Jogo / Confrontos Diretos
  h2hCountersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  h2hCounterBlock: {
    flex: 1,
    alignItems: 'flex-start',
  },
  h2hCounterBlockCenter: {
    width: 76,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  h2hCounterBlockRight: {
    flex: 1,
    alignItems: 'flex-end',
  },
  h2hTeamLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  h2hTeamCodeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  h2hBigCountText: {
    fontSize: 26,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  h2hTeamAAccent: {
    color: '#0A84FF',
  },
  h2hTeamBAccent: {
    color: '#22c55e',
  },
  h2hDrawCountText: {
    color: '#8E8E93',
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    marginTop: 22,
  },
  h2hSubLabelText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
  },
  h2hBarTrack: {
    flexDirection: 'row',
    height: 7,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#2C2C2E',
    gap: 3,
  },
  h2hBarSegmentA: {
    backgroundColor: '#0A84FF',
    borderRadius: 999,
  },
  h2hBarSegmentDraw: {
    backgroundColor: '#636366',
    borderRadius: 999,
  },
  h2hBarSegmentB: {
    backgroundColor: '#22c55e',
    borderRadius: 999,
  },
  h2hBarSegmentNeutral: {
    backgroundColor: '#3A3A3C',
  },
  h2hBarSegmentNeutralRight: {
    backgroundColor: '#3A3A3C',
  },
  // Desempenho da Equipa (Form — 5 Badges)
  formTeamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  formRowsDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#2C2C2E',
    marginVertical: 10,
  },
  formTeamIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  formTeamNameText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  formBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  formBadge: {
    minWidth: 38,
    height: 26,
    paddingHorizontal: 6,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  formBadgeWin: {
    backgroundColor: 'rgba(34, 197, 94, 0.20)',
    borderColor: 'rgba(34, 197, 94, 0.55)',
  },
  formBadgeLoss: {
    backgroundColor: 'rgba(255, 69, 58, 0.20)',
    borderColor: 'rgba(255, 69, 58, 0.55)',
  },
  formBadgeDraw: {
    backgroundColor: 'rgba(142, 142, 147, 0.20)',
    borderColor: 'rgba(142, 142, 147, 0.45)',
  },
  formBadgeEmpty: {
    backgroundColor: '#141416',
    borderColor: '#2C2C2E',
  },
  formBadgeScoreText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  formBadgeEmptyText: {
    color: '#636366',
    fontSize: 11,
    fontWeight: '700',
  },
  // Onde Assistir (Streams)
  streamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  streamRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  streamRowPressed: {
    opacity: 0.72,
  },
  streamLeftInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 10,
  },
  streamFlagText: {
    fontSize: 20,
    marginRight: 10,
  },
  streamTextBlock: {
    flex: 1,
  },
  streamChannelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  streamChannelName: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  officialBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
  },
  officialBadgeText: {
    color: '#22c55e',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  streamLangMeta: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '500',
    marginTop: 2,
  },
  streamRightBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  platformPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  platformPillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  streamChevron: {
    color: '#8E8E93',
    fontSize: 14,
    fontWeight: '700',
  },
  // Tabela de Classificações (Standings)
  standingsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 8,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C2E',
  },
  standingsHeaderLabel: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  standingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    marginVertical: 1,
  },
  standingsRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  standingsRowHighlightA: {
    backgroundColor: 'rgba(10, 132, 255, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(10, 132, 255, 0.45)',
  },
  standingsRowHighlightB: {
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  standingsColRank: {
    width: 28,
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  standingsColTeamHeader: {
    flex: 1,
    paddingLeft: 4,
  },
  standingsColTeam: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 8,
  },
  standingsTeamName: {
    flex: 1,
    color: '#E5E5EA',
    fontSize: 13,
    fontWeight: '600',
  },
  standingsColPoints: {
    width: 42,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  standingsColWL: {
    width: 52,
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  standingsTextHighlighted: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  standingsWLHighlighted: {
    color: '#E5E5EA',
    fontWeight: '800',
  },
  // Aba "Partidas" — Lista de Confrontos Diretos (FlatList)
  listSectionLabel: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 8,
    marginLeft: 4,
  },
  h2hMatchItemCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  h2hMatchMetaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2C2C2E',
  },
  h2hMatchDateText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  h2hMatchTournamentText: {
    flex: 1,
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'right',
    marginLeft: 10,
  },
  h2hMatchScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  h2hMatchTeamLeft: {
    flex: 1,
    fontSize: 13,
    textAlign: 'left',
    paddingRight: 8,
  },
  h2hMatchTeamRight: {
    flex: 1,
    fontSize: 13,
    textAlign: 'right',
    paddingLeft: 8,
  },
  h2hMatchWinnerText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  h2hMatchLoserText: {
    color: '#8E8E93',
    fontWeight: '600',
  },
  h2hMatchScorePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2C2C2E',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 10,
    gap: 6,
  },
  h2hMatchScoreNumber: {
    color: '#E5E5EA',
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  h2hMatchScoreWinnerA: {
    color: '#0A84FF',
  },
  h2hMatchScoreWinnerB: {
    color: '#22c55e',
  },
  h2hMatchScoreSeparator: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '700',
  },
  // Elencos (Rosters)
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
});
