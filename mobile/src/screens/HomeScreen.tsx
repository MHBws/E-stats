// =============================================================================
// mobile/src/screens/HomeScreen.tsx — Tela Inicial de Partidas (Apple Sports)
// -----------------------------------------------------------------------------
// O QUE: Carrega a lista de partidas via `fetchMatches()` e renderiza os cards.
// POR QUE: Separa a camada de orquestração de tela (`screens/`) dos componentes
//          visuais puros (`components/`), preparando a navegação para o placar
//          ao vivo (`useLiveMatch`).
// =============================================================================
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { fetchMatches } from '../api/apiClient';
import { MatchCard } from '../components/MatchCard';
import type { MatchCardDto } from '../types/match';

export function HomeScreen(): React.JSX.Element {
  const [matches, setMatches] = useState<MatchCardDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    fetchMatches()
      .then((data) => {
        if (active) {
          setMatches(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar partidas.');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>CS2 Scores</Text>
      </View>

      {loading ? (
        <ActivityIndicator color="#FFFFFF" size="large" style={styles.loader} />
      ) : error ? (
        <Text style={styles.errorText}>{error}</Text>
      ) : (
        <FlatList
          data={matches}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <MatchCard match={item} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  loader: {
    marginTop: 48,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 14,
    paddingHorizontal: 20,
    marginTop: 24,
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
});
