// =============================================================================
// mobile/src/screens/HomeScreen.tsx — Tela Inicial de Partidas (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Busca as partidas na API REST (`fetchMatches()`), exibe um Segmented
//        Control horizontal ("Ontem" | "Hoje" | "Próximos") inspirado no Apple
//        Sports, filtra os jogos em memória com `useMemo` para troca instantânea
//        de aba e renderiza a `FlatList` com suporte a "Pull to Refresh".
//
// POR QUE (Escolhas de Flexbox & Otimização de Re-renderização):
//   1. Filtragem em Memória (`useMemo`) + Opção A do BFF (janela D-4 a D+7):
//      Ao carregar toda a janela de partidas em uma única requisição REST e
//      filtrar as abas em memória, a troca entre "Ontem", "Hoje" e "Próximos"
//      acontece em 0ms (sem spinner de rede a cada toque).
//   2. `useCallback` em `handlePressMatch` e `renderMatchItem` + `keyExtractor`
//      fora do componente: Garante referências de função estáveis entre renders,
//      permitindo que o `React.memo` do `MatchCard` pule a reconciliação dos
//      itens que não mudaram.
//   3. Paleta Dark Mode OLED (`#000000` fundo, `#1C1C1E` container, `#2C2C2E`
//      aba ativa, `#FFFFFF` primário, `#8E8E93` secundário): Desliga pixels
//      pretos em telas OLED e replica a hierarquia visual do Apple Sports.
// =============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { fetchMatches } from '../api/apiClient';
import { MatchCard } from '../components/MatchCard';
import type { MatchCardDto, RootStackParamList } from '../types/match';

export type HomeScreenProps = NativeStackScreenProps<RootStackParamList, 'Home'>;

// [UPDATE]: Tipagem das 3 abas do Segmented Control estilo Apple Sports.
export type HomeTab = 'yesterday' | 'today' | 'upcoming';

const TABS: Array<{ key: HomeTab; label: string }> = [
  { key: 'yesterday', label: 'Ontem' },
  { key: 'today', label: 'Hoje' },
  { key: 'upcoming', label: 'Próximos' },
];

// `keyExtractor` estático fora do componente evita recriação de closure a cada render.
const extractMatchKey = (item: MatchCardDto): string => item.id;

/**
 * [UPDATE]: Calcula os limites do dia atual (00:00:00.000 até 23:59:59.999)
 * no fuso horário local do dispositivo para classificar as partidas nas abas.
 */
function getTodayBounds(): { startOfTodayMs: number; endOfTodayMs: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return {
    startOfTodayMs: startOfToday.getTime(),
    endOfTodayMs: endOfToday.getTime(),
  };
}

export function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  const [matches, setMatches] = useState<MatchCardDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // [UPDATE]: Módulo 8 — Estado dedicado ao gesto "Pull to Refresh" da FlatList.
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // [UPDATE]: Estado local da aba ativa (inicia em 'today' como no Apple Sports).
  const [activeTab, setActiveTab] = useState<'yesterday' | 'today' | 'upcoming'>('today');

  const loadMatches = useCallback(async (isPullToRefresh = false): Promise<void> => {
    if (isPullToRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const data = await fetchMatches();
      setMatches(data);
      setError(null);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível atualizar a lista de partidas.',
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadMatches(false);
  }, [loadMatches]);

  // [UPDATE]: Filtra e ordena instantaneamente as partidas em memória conforme a aba ativa:
  //   - 'yesterday': status === 'finished' OU data estritamente anterior a hoje.
  //   - 'today':     status === 'live' OU data exatamente no dia de hoje.
  //   - 'upcoming':  data estritamente posterior ao dia de hoje.
  const filteredMatches = useMemo((): MatchCardDto[] => {
    const { startOfTodayMs, endOfTodayMs } = getTodayBounds();

    const filtered = matches.filter((match) => {
      const matchTimeMs = new Date(match.scheduled_at).getTime();
      const hasValidDate = !Number.isNaN(matchTimeMs);

      const isBeforeToday = hasValidDate && matchTimeMs < startOfTodayMs;
      const isSameDayAsToday =
        hasValidDate && matchTimeMs >= startOfTodayMs && matchTimeMs <= endOfTodayMs;
      const isAfterToday = hasValidDate && matchTimeMs > endOfTodayMs;

      if (activeTab === 'yesterday') {
        return match.status === 'finished' || isBeforeToday;
      }

      if (activeTab === 'today') {
        return match.status === 'live' || isSameDayAsToday;
      }

      // activeTab === 'upcoming'
      return isAfterToday;
    });

    // Na aba "Ontem", ordena das mais recentes para as mais antigas.
    if (activeTab === 'yesterday') {
      return [...filtered].sort(
        (a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime(),
      );
    }

    return filtered;
  }, [matches, activeTab]);

  // [UPDATE]: Módulo 8 — Navega para `LiveMatchScreen` passando o `matchId`.
  // Memoizado com `useCallback` para preservar a otimização `React.memo` do `MatchCard`.
  const handlePressMatch = useCallback(
    (match: MatchCardDto): void => {
      // [UPDATE]: Fallback para o nome completo quando a equipe não possui sigla na API.
      const teamA = match.team_a?.acronym ?? match.team_a?.name ?? 'TBD';
      const teamB = match.team_b?.acronym ?? match.team_b?.name ?? 'TBD';
      navigation.navigate('LiveMatch', {
        matchId: match.id,
        title: `${teamA} vs ${teamB}`,
      });
    },
    [navigation],
  );

  const renderMatchItem = useCallback(
    ({ item }: ListRenderItemInfo<MatchCardDto>): React.JSX.Element => (
      <MatchCard match={item} onPress={handlePressMatch} />
    ),
    [handlePressMatch],
  );

  const emptyMessageByTab: Record<HomeTab, string> = {
    yesterday: 'Nenhuma partida finalizada recente encontrada.',
    today: 'Nenhuma partida agendada ou ao vivo para hoje.',
    upcoming: 'Nenhuma partida futura agendada nos próximos dias.',
  };

  return (
    <View style={styles.container}>
      <View style={styles.subHeader}>
        <Text style={styles.sectionTitle}>COUNTER-STRIKE 2</Text>
        <Text style={styles.sectionSubtitle}>Placar em tempo real</Text>
      </View>

      {/* [UPDATE]: Segmented Control horizontal ("Ontem" | "Hoje" | "Próximos") estilo Apple Sports */}
      <View style={styles.segmentedWrapper}>
        <View style={styles.segmentedContainer}>
          {TABS.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <Pressable
                key={tab.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                onPress={() => setActiveTab(tab.key)}
                style={[styles.segmentButton, isActive && styles.segmentButtonActive]}
              >
                <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>
                  {tab.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {loading && !refreshing ? (
        <View style={styles.centeredState}>
          <ActivityIndicator color="#FFFFFF" size="large" />
          <Text style={styles.helperText}>Carregando partidas...</Text>
        </View>
      ) : (
        <FlatList
          data={filteredMatches}
          keyExtractor={extractMatchKey}
          renderItem={renderMatchItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          // Otimizações nativas de janela da FlatList para rolagem a 60/120fps.
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={5}
          removeClippedSubviews
          // [UPDATE]: Módulo 8 — Suporte a "Pull to Refresh" nativo iOS/Android.
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void loadMatches(true)}
              tintColor="#FFFFFF"
              colors={['#FFFFFF']}
              progressBackgroundColor="#1C1C1E"
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>
                {error ? 'Servidor indisponível' : 'Nenhuma partida encontrada'}
              </Text>
              <Text style={styles.emptyDescription}>
                {error ?? emptyMessageByTab[activeTab]}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // Fundo OLED puro (#000000).
    backgroundColor: '#000000',
  },
  subHeader: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 10,
  },
  sectionTitle: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  sectionSubtitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 2,
  },
  // [UPDATE]: Container do Segmented Control com espaçamento simétrico e visual Apple Sports.
  segmentedWrapper: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  segmentedContainer: {
    flexDirection: 'row',
    backgroundColor: '#1C1C1E',
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentButtonActive: {
    backgroundColor: '#2C2C2E',
  },
  segmentText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  centeredState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  helperText: {
    color: '#8E8E93',
    fontSize: 13,
    marginTop: 12,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 36,
  },
  emptyCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 24,
    marginTop: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6,
  },
  emptyDescription: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
