// =============================================================================
// mobile/src/screens/HomeScreen.tsx — Tela Inicial de Partidas (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Busca as partidas na API REST (`fetchMatches()`), exibe a lista em uma
//        `FlatList` de alta performance com suporte a "Pull to Refresh" e
//        navega para `LiveMatchScreen` ao tocar em qualquer card.
//
// POR QUE (Escolhas de Flexbox & Otimização de Re-renderização):
//   1. `useCallback` em `handleSelectMatch` e `renderMatchItem` + `keyExtractor`
//      fora do componente: Garante referências de função estáveis entre renders,
//      permitindo que o `React.memo` do `MatchCard` pule a reconciliação dos
//      itens que não mudaram durante o Pull-to-Refresh.
//   2. Paleta Dark Mode OLED (`#000000` fundo, `#FFFFFF` primário, `#8E8E93`
//      secundário): Desliga fisicamente os pixels pretos em telas OLED de
//      iPhones/Androids modernos, economizando bateria enquanto o usuário
//      acompanha jogos longos.
// =============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItemInfo,
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

// `keyExtractor` estático fora do componente evita recriação de closure a cada render.
const extractMatchKey = (item: MatchCardDto): string => item.id;

export function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  const [matches, setMatches] = useState<MatchCardDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  // [UPDATE]: Módulo 8 — Estado dedicado ao gesto "Pull to Refresh" da FlatList.
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <View style={styles.container}>
      <View style={styles.subHeader}>
        <Text style={styles.sectionTitle}>COUNTER-STRIKE 2</Text>
        <Text style={styles.sectionSubtitle}>Placar em tempo real</Text>
      </View>

      {loading && !refreshing ? (
        <View style={styles.centeredState}>
          <ActivityIndicator color="#FFFFFF" size="large" />
          <Text style={styles.helperText}>Carregando partidas...</Text>
        </View>
      ) : (
        <FlatList
          data={matches}
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
                {error ?? 'Arraste para baixo para atualizar o calendário de CS2.'}
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
    paddingBottom: 14,
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
