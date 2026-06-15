import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadPersistedState } from '@/lib/db/sessions';
import { initRevenueCat } from '@/lib/revenuecat';
import { refreshStreakFromHistory } from '@/lib/streak';
import { backfillAccountOwner, pushState } from '@/lib/sync';
import { useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

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
        // Recompute the streak from the activity ledger so a lapsed day is
        // reflected on launch (not just after the next turn). Best-effort.
        void refreshStreakFromHistory();
      } catch {
        // Fall through to defaults.
      } finally {
        // Subscription bootstrap: configure RC, hydrate cached entitlement
        // before routing, then kick a background refresh.
        try {
          useAuthStore.getState().init();
          // Stamp ownership of local data for an already-signed-in (restored)
          // session so a later account switch is detected. Never wipes. Best-effort.
          void backfillAccountOwner();
          await initRevenueCat();
          // Free-taste meter must load BEFORE hydrateFromCache flips `ready` — the
          // gate reads it the instant routing unblocks, so loading it after would
          // briefly render the conversation to an exhausted user before bouncing.
          await useSubscriptionStore.getState().hydrateFreeUsageFromCache();
          await useSubscriptionStore.getState().hydrateFromCache();
          await useSubscriptionStore.getState().hydrateUsageFromCache();
          void useSubscriptionStore.getState().refresh();
        } catch {
          // Never block launch on billing.
        }
        setHydrated(true);
        SplashScreen.hideAsync().catch(() => {});
      }
    })();
  }, [hydrate]);

  // Cross-device sync is opt-in and bidirectional: pull/seed at sign-in, and
  // push the learning profile up whenever the app backgrounds. pushState() is a
  // no-op for signed-out users, so this is safe to always register.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') void pushState();
    });
    return () => sub.remove();
  }, []);

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
              name="progress"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="streak"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="privacy"
              options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
            />
            <Stack.Screen
              name="paywall"
              options={{ presentation: 'modal', animation: 'fade', gestureEnabled: false }}
            />
          </Stack>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
