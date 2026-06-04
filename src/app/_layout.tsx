import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadPersistedState } from '@/lib/db/sessions';
import { useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { colors, mode } = useTheme();
  const hydrate = useAppStore((s) => s.hydrate);
  const [hydrated, setHydrated] = useState(false);

  // Restore persisted state before any routing decision (spec §3.2, §7.2).
  // Never let a slow storage layer block the app from launching.
  useEffect(() => {
    (async () => {
      try {
        const state = await Promise.race([
          loadPersistedState(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (state) hydrate(state);
      } catch {
        // Fall through to defaults.
      } finally {
        setHydrated(true);
        SplashScreen.hideAsync().catch(() => {});
      }
    })();
  }, [hydrate]);

  if (!hydrated) return null;

  const navTheme = mode === 'dark' ? DarkTheme : DefaultTheme;
  navTheme.colors.background = colors.background;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
              animation: 'fade',
            }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="onboarding" />
            <Stack.Screen name="conversation" />
            <Stack.Screen
              name="settings"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="account"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="privacy"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
          </Stack>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
