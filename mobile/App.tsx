// =============================================================================
// mobile/App.tsx — Navegação Cross-Platform (iOS/Android) e Tema OLED
// -----------------------------------------------------------------------------
// O QUE: Configura o `NavigationContainer` com tema Dark Mode OLED (`#000000`)
//        e o `createNativeStackNavigator` registrando `HomeScreen` ("Esports")
//        e `LiveMatchScreen` (com botão de voltar nativo).
// POR QUE: O `@react-navigation/native-stack` utiliza `UINavigationController`
//          no iOS e `Fragment` nativo no Android, garantindo transições a
//          60/120fps na GPU e gesto nativo de swipe-back sem travar a thread JS
//          que processa o WebSocket do placar ao vivo.
// =============================================================================
import React from 'react';
import { StatusBar } from 'expo-status-bar';
// [UPDATE]: Módulo 8 — Configuração do React Navigation (Native Stack) e tema OLED.
import { DarkTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { HomeScreen } from './src/screens/HomeScreen';
import { LiveMatchScreen } from './src/screens/LiveMatchScreen';
import type { RootStackParamList } from './src/types/match';

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Tema OLED com fundo #000000 e superfícies #1C1C1E para evitar flashes brancos na transição. */
const AppleSportsOledTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#FFFFFF',
    background: '#000000',
    card: '#000000',
    text: '#FFFFFF',
    border: '#1C1C1E',
    notification: '#FF453A',
  },
};

export default function App(): React.JSX.Element {
  return (
    <NavigationContainer theme={AppleSportsOledTheme}>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: { backgroundColor: '#000000' },
          headerTintColor: '#FFFFFF',
          headerShadowVisible: false,
          contentStyle: { backgroundColor: '#000000' },
        }}
      >
        {/* HomeScreen com header grande e preto escrito "Esports" (estilo iOS/Apple Sports) */}
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{
            title: 'Esports',
            headerLargeTitle: true,
            headerLargeStyle: { backgroundColor: '#000000' },
            headerTitleStyle: {
              color: '#FFFFFF',
              fontSize: 22,
              fontWeight: '800',
            },
          }}
        />

        {/* LiveMatchScreen com botão de voltar nativo */}
        <Stack.Screen
          name="LiveMatch"
          component={LiveMatchScreen}
          options={({ route }) => ({
            title: route.params.title ?? 'Ao Vivo',
            headerBackTitle: 'Esports',
          })}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
