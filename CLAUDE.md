# Parlez

Voice-first AI app whose single goal: get English speakers actually speaking French.
One conversation screen. An AI tutor, **Marie**, speaks French, listens, gently corrects,
remembers what the user struggles with. No gamification, no lessons, no dashboards.

Full product spec: `docs/Parlez_Product_Specification_v1.0.docx`.
Implementation plan: see the approved plan referenced in the spec discussion.

## Core principle
If a feature does not help the user speak French, it does not ship.

## Stack
Expo SDK 56 | React Native 0.85 | expo-router (typed routes) | TypeScript |
Zustand (state) | expo-sqlite (local store) | expo-audio (record/playback) |
react-native-reanimated 4 | Supabase (BFF Edge Functions + Auth + Postgres sync)

## Layout
src/app/        Routes: index (gate), onboarding, conversation, settings (modal)
src/components/ Design-system components
src/lib/        theme, constants, services, audio, db
src/stores/     Zustand stores
supabase/       Edge functions (turn, tts, sync) + migrations

## Conventions
- All colours from `useTheme()` in `src/lib/theme.ts`. Never hard-code a hex.
- Conversation-rhythm timings live in `src/lib/constants.ts` — sourced from the spec.
- Path alias `@/` -> `src/`.
- STT/AI/TTS sit behind the `ConversationService` interface. Mock impl for dev
  without API keys; Supabase impl for real providers. Switched by env.
- Voice audio is never persisted (spec §8) — transcribe, then discard.
- Dark mode supported from day one.

## Dev commands
cd "C:\Users\Denny\3D Objects\APPS\Parlez"
npx expo start          # w = web, i = iOS, a = Android
npx tsc --noEmit        # typecheck
