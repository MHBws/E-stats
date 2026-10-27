// =============================================================================
// mobile/App.tsx — Ponto de Entrada do App Mobile (Expo)
// =============================================================================
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { HomeScreen } from './src/screens/HomeScreen';

export default function App(): React.JSX.Element {
  return (
    <>
      <StatusBar style="light" />
      <HomeScreen />
    </>
  );
}
