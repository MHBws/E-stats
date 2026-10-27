// =============================================================================
// mobile/src/api/apiClient.ts — Cliente HTTP REST do App Mobile
// -----------------------------------------------------------------------------
// O QUE: Centraliza as chamadas HTTP (`fetch` nativo do React Native) para o
//        BFF em `http://10.0.2.2:3000/api`, expondo `fetchMatches(status?)` e
//        `fetchMatchById(id)`.
// POR QUE: Usar o `fetch` nativo do Hermes/React Native evita adicionar peso ao
//          bundle (sem axios) e concentra tratamento de erro, headers e URL base
//          em um único ponto.
// =============================================================================
import type { MatchCardDto, MatchDetailDto } from '../types/match';

// [UPDATE]: Usa o IP especial de loopback do Emulador Android (`10.0.2.2`), que
// roteia diretamente para o `127.0.0.1` da máquina hospedeira onde o Docker expõe
// a porta 3000. Corrigido também formato de string pura (sem sintaxe Markdown).
export const API_BASE_URL = 'http://10.0.2.2:3000/api';

/**
 * Wrapper genérico de `fetch` com cabeçalhos JSON e tratamento de status HTTP.
 */
async function apiFetch<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`[apiClient] HTTP ${response.status} em ${endpoint}: ${errorText}`);
  }

  return (await response.json()) as T;
}

/**
 * Busca a lista de partidas para a Home Screen (`GET /api/matches`).
 * @param status Filtro opcional (`'live'`, `'scheduled'`, `'finished'`, etc.).
 * @param date Filtro opcional de data (`'YYYY-MM-DD'`).
 */
export async function fetchMatches(status?: string, date?: string): Promise<MatchCardDto[]> {
  const params = new URLSearchParams();
  if (status) {
    params.set('status', status);
  }
  if (date) {
    params.set('date', date);
  }

  const query = params.toString();
  const endpoint = query ? `/matches?${query}` : '/matches';
  return apiFetch<MatchCardDto[]>(endpoint, { method: 'GET' });
}

/**
 * Busca os detalhes completos de uma partida + mapas do veto (`GET /api/matches/:id`).
 */
export async function fetchMatchById(id: string): Promise<MatchDetailDto> {
  return apiFetch<MatchDetailDto>(`/matches/${encodeURIComponent(id)}`, { method: 'GET' });
}
