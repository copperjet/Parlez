# Parlez — Fix Log

Running record of bugs, diagnoses, attempted fixes, and outcomes. Append newest
at the top of each section. Goal: never re-debug the same issue twice.

Format per entry:
- **Symptom** — what the user saw.
- **Root cause** — the actual mechanism, once known.
- **Fix** — what changed (files), or what's still pending.
- **Status** — ✅ fixed & verified | 🟡 fix applied, unverified | 🔴 open/blocked.
- **Verify** — how to confirm.

---

## Build & release environment

### EAS free-tier build quota exhausted (account `denny-32`)
- **Symptom:** `eas build` refused — monthly free build credits used up.
- **Root cause:** EAS Build free plan = limited builds **per Expo account per month**.
  Quota is per-account (email), not per-device. Cloud builds run on Expo servers;
  the phone only downloads the finished APK.
- **Fix:** Logged into a second Expo account (`acecode10`) → fresh monthly quota.
  Ran `eas init --non-interactive --force` to create a new project under it.
- **Status:** ✅ working. `denny-32` quota resets 1st of month.
- **Notes:**
  - `app.json` `owner` + `extra.eas.projectId` now point at `acecode10`
    (projectId `edca72fd-af2f-49ed-a0f5-fbdde06e73ac`). Old `denny-32` project was
    `0d1471e5-1964-4377-b247-1297815db065`.
  - Each Expo account auto-generates its **own Android keystore** → different app
    signature → can't update-install over an APK signed by another account.
    Uninstall the old app first when switching build accounts.
  - Stacking multiple emails = stacking separate monthly quotas.

### Local Gradle build fails — disk full
- **Symptom:** `npx expo run:android` failed ~21 min in: `IOException: There is not
  enough space on the disk` during `:expo-modules-core:buildCMakeDebug` /
  `:react-native-reanimated:buildCMakeDebug`.
- **Root cause:** C: drive was at/near 0 free. RN debug build with native modules
  (CMake C++ compile across arm64) needs ~8–10 GB free headroom. Clearing Gradle/npm
  caches freed ~5 GB but the build re-consumed it (re-downloaded deps + native `.o`).
- **Fix:** Switched to EAS **cloud** build (no local disk used).
- **Status:** ✅ worked around via cloud. Local build still blocked until ~10 GB free.

---

## Conversation / turn engine

### ✅ "Camille couldn't respond just now" on every spoken reply (audio Blob crash)
- **Symptom:** User taps mic, speaks (transcript appears, e.g. "salut"), taps stop to
  send. Message sends, but a red banner shows "Camille couldn't respond just now.
  Please try again in a moment." and Camille speaks the fallback line
  "Oh, j'ai un petit problème technique. Un instant, et on reprend." — repeated
  several times (the engine's one auto-retry + the loop re-prompting).
- **Diagnosis (2026-06-09):**
  - The **send path is fine** — this is a *server* turn failure, not the mic.
  - Client `callTurn` (`src/lib/services/supabaseService.ts`) POSTs to the `turn`
    Edge Function. On `!res.ok` (non-402/403) it throws a generic
    `turn failed: <status>`; the engine catch (`turnStateMachine.ts:450-468`) maps a
    null response → the "couldn't respond" banner + `AI_ERROR_SPEECH`.
  - 402 → daily-cap, 403 → `NotEntitledError` → routes to paywall. Neither fired
    (no paywall redirect), so the real status is **500**.
  - The `turn` function's outer `catch` returns `{ error }` 500 when an inner step
    throws. For a **text** reply (native STT already produced text, no audio), Whisper
    is skipped, so the throw is in `generate()` →
    `if (!key) throw new Error('ANTHROPIC_API_KEY not set')`, or a provider HTTP error
    (`claude <status>` / `whisper <status>`).
  - **Probes** (anon key, against `xfwqikixqqgzxsxgxxqn.supabase.co/functions/v1/turn`):
    - `mode=open`, no `app_user_id` → **403** `not_entitled` (caller unresolved).
    - `mode=reply`, fake `app_user_id`, `text=salut` → **403** `not_entitled`
      (entitlement gate works cleanly; it does **not** throw/fail-open).
  - Therefore the real in-app user **is entitled** (subscription row or RC fallback),
    passes the gate, and dies in `generate()` → strongly implies
    **`ANTHROPIC_API_KEY` (and/or `OPENAI_API_KEY`) is missing or invalid** in the
    Supabase project's function secrets.
- **Blocker:** The app talks to Supabase project **`xfwqikixqqgzxsxgxxqn`**, but the
  Supabase CLI is logged into a **different** account whose "Parlez" project is
  `dopvasbnomzjyogmsmis`. Can't read/set `xfwqikixqqgzxsxgxxqn`'s secrets from here.
- **Fix routes (pending user decision):**
  - **A (fastest, server-only, no rebuild):** Log Supabase CLI into the account that
    owns `xfwqikixqqgzxsxgxxqn`, `supabase link`, then
    `supabase secrets list` to confirm, and
    `supabase secrets set ANTHROPIC_API_KEY=… OPENAI_API_KEY=…`.
  - **B:** Repoint the app at a Supabase project this CLI controls
    (`dopvasbnomzjyogmsmis`): deploy functions, run migrations, set secrets, update
    `EXPO_PUBLIC_SUPABASE_URL`/anon in `eas.json` + `.env`, rebuild.
- **Recommended client hardening (do regardless):** make `callTurn` read the 500
  `{ error }` body and surface it (DEV log / captured `lastTurnError`) so future
  server failures are diagnosable on-device without server access — mirrors the STT
  self-diagnosing fix.
- **Applied (2026-06-09):** Logged Supabase CLI into the account owning
  `xfwqikixqqgzxsxgxxqn` (org `hwwwnhldicwafmtbhmhs`). Confirmed via
  `supabase secrets list` that `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` are now set
  (they were missing → the 500). Edge Function secrets apply at runtime — **no app
  rebuild required**; the installed APK picks them up on the next turn.
- **Update (2026-06-09, still failing after keys set):** Setting the keys did NOT
  fix it — and the Anthropic key showed "last used today", so it was likely present
  all along. The missing-key theory was wrong. Couldn't read the cause server-side:
  CLI account is a limited org member (`functions list`/`logs` → 403 privileges; only
  `secrets list` works), and flipping `PARLEZ_MOCK` was correctly blocked (shared
  prod infra).
- **New suspect:** `ANTHROPIC_MODEL` secret is **not set** → function defaults to
  model id `claude-haiku-4-5`. If that id is invalid on this Anthropic account, every
  Claude call → 400/404 → the function's outer catch → 500 → the banner. (A text
  reply skips Whisper, so the failure must be in `generate()`.)
- **Diagnostic build (client self-diagnosis, mirrors the STT fix):**
  - `supabaseService.ts callTurn`: on `!res.ok`, read the response body and throw
    `turn <status>: <body>` instead of a bare status.
  - `turnStateMachine.ts`: capture `lastTurnError` in the send-retry catch
    (`__DEV__` logs `[turn] …`); **TEMP DEBUG** — append `[<lastTurnError>]` to the
    "couldn't respond" banner so the real cause is readable on a preview build.
    → revert the banner append once fixed (search `DEBUG-DIAG`).
  - Built preview APK on `acecode10` to read the cause on-device.
- **ACTUAL ROOT CAUSE (2026-06-09, confirmed on-device):** The diagnostic build's
  banner read:
  `Camille couldn't respond just now. [Creating blobs from 'ArrayBuffer' and
  'ArrayBufferView' are not supported]`.
  **Not a server error at all** — a *client* exception thrown in
  `supabaseService.callTurn` **before** the request leaves the phone. Under RN 0.85
  / Hermes, `await fetch(opts.audioUri).blob()` (used to attach the recording for
  Whisper) throws because the runtime's Blob impl rejects ArrayBuffer-backed blobs.
  The throw propagated up → engine `response == null` → the generic banner +
  `AI_ERROR_SPEECH`. The Supabase keys/model were never the problem (the request
  never reached the server). All earlier server-side theories were red herrings;
  the client-side error-surfacing build is what found it.
- **Fix (`src/lib/services/supabaseService.ts`):** Attach audio **only when there is
  no device transcript** (`opts.audioUri && !opts.text`). Native STT already
  provides text, and the server falls back to it anyway, so the common path is now
  text-only — no Blob construction. The blob build is additionally wrapped in
  try/catch so the audio-only path degrades to a clean server STT-miss instead of
  throwing the whole turn.
- **Lesson:** A generic "couldn't respond" / null-response banner is NOT necessarily
  a server failure. The client throws (FormData/Blob, network, JSON) land in the
  same catch. The fix that made this debuggable — surfacing the caught error
  message on-device — is worth keeping behind a debug flag.
- **Status:** ✅ confirmed on device (2026-06-09) — Camille replies for real, no
  banner. Debug banner append reverted to the clean message; the `lastTurnError`
  capture + `__DEV__ console.warn('[turn]', …)` and the server-body capture in
  `callTurn` are kept (cheap, invaluable for the next failure).
  - ⚠️ During the revert, line ~463 of `turnStateMachine.ts` got mangled into curly
    quotes (`‘You’re offline…’`) → `tsc` TS1127 "Invalid character". Fixed back to
    straight delimiters. **Always run `npx tsc --noEmit` after hand-edits near
    smart-quoted strings.**

---

## RUNBOOK — "Camille couldn't respond" / null-turn banner recurs

Triggered by the engine's `response == null` branch (`turnStateMachine.ts`), which
fires for **any** thrown error in the send-retry loop — client OR server. Don't
assume it's the backend. Diagnose in this order:

1. **Get the real error first — don't theorize.** It's already captured:
   - Dev/debug build: Metro console shows `[turn] <message>` (and `[stt] …`).
   - Preview/release (no console): temporarily re-add the on-device surface —
     append `` `[${lastTurnError ?? 'unknown'}]` `` to the banner string in the
     `response == null` block, rebuild preview, read the bracket on-device, then
     revert. (This is exactly how the Blob bug was found.) `callTurn` already throws
     `turn <status>: <body>` so server 500 bodies come through too.
2. **Classify the bracket text:**
   - `Creating blobs from 'ArrayBuffer'…` / `Unsupported FormDataPart` →
     **client** audio-upload bug (RN Blob/FormData). See the audio-Blob fix above:
     prefer device `text`, guard the blob. Do NOT touch Supabase.
   - `turn 401/403` → auth/entitlement. 403 should route to paywall, not this
     banner — if it lands here, the client isn't sending `app_user_id` / the JWT.
   - `turn 500: ANTHROPIC_API_KEY not set` / `claude <status>` / `whisper <status>`
     → **server**. Check Supabase function secrets + model id (below).
   - `Network request failed` / offline → connectivity; the offline branch should
     handle it (check `onlineRef`).
3. **Server-side checks (only if the bracket says so):**
   - The app's project is **`xfwqikixqqgzxsxgxxqn`** (org `hwwwnhldicwafmtbhmhs`).
     Log the Supabase CLI into THAT account before anything (`npx supabase login`,
     it must appear in `supabase projects list`).
   - `npx supabase secrets list --project-ref xfwqikixqqgzxsxgxxqn` — need
     `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. `ANTHROPIC_MODEL` is optional (defaults
     to `claude-haiku-4-5` in `supabase/functions/turn/index.ts`); set it if that id
     is invalid. Provider keys live ONLY in Supabase secrets — **never** in `.env` /
     `eas.json` (those ship in the APK bundle and would leak).
   - Edge Function secrets apply at runtime → **no app rebuild** needed for a
     server-only fix; just retry in the installed app.
   - This CLI account is a limited org member: `supabase functions list` / `logs`
     return 403 "necessary privileges"; only `secrets list` works. Read function
     logs from the Supabase **dashboard** (Edge Functions → turn → Logs) instead.
4. **Reproduce a server turn from the CLI** (bypasses the device):
   `curl -X POST .../functions/v1/turn -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -F mode=reply -F app_user_id=<entitled-id> -F text=salut -F 'context={"level":"A","history":[],"personaName":"Camille"}'`
   — 403 `not_entitled` means the gate works (caller just isn't entitled); a 500
   body shows the real provider error.

### ✅ Tap-to-send did nothing (transcript captured but never sent)
- **Symptom:** After speaking, tapping the stop button discarded the turn — nothing
  sent.
- **Root cause:** `onMicPress` handled `listening` and `recording` with the same
  `turnOff()`, throwing away the live transcript in the `recording` state.
- **Fix:** Split the branches in `src/lib/turnStateMachine.ts` — `recording` →
  `requestFinish(true)` (finalize + send); `listening` (no speech yet) → `turnOff()`.
- **Status:** ✅ verified on device (2026-06-09 APK) — "salut" sent through to the
  server (the failure after that is the separate server 500 above).

### ✅ Mic "Couldn't hear the mic — tap to try again." instantly on tap
- **Symptom:** Banner appeared the moment the user tapped the mic, before speaking.
- **Root cause:** Runaway-recognizer guard fired after 4 empty recognizer `end`
  events; the recognizer's `error` code was discarded, collapsing every cause
  (permission / no service / offline / no-speech) into one generic message. No
  permission preflight.
- **Fix (`turnStateMachine.ts`, `recognizer.ts`):**
  - Added non-throwing `getRecognitionPermissions()` preflight before live mode;
    revoked mic → immediate clear "Microphone access is off…" instead of a storm.
  - Capture `lastRecognizerError`; `__DEV__` logs `[stt] <code> <message>`.
  - `micFailureNotice()` branches the banner by cause (not-allowed / network-offline /
    generic).
- **Status:** ✅ recognizer confirmed working on device (transcript captured).

---

## Paywall / monetization

### ✅ Buy button always read "Buy lifetime — one payment"
- **Symptom:** Every plan card (Annual / Monthly / Lifetime) showed the same lifetime
  CTA — misrepresents the purchase (Play Store rejection risk).
- **Root cause:** CTA label hardcoded for the no-trial branch; ignored `selected` tier.
- **Fix (`src/app/paywall.tsx`):** derive label from `selected` —
  trial → "Start <len> free trial"; `lifetime` → "Buy lifetime — one payment";
  else → "Buy <tier> — <priceString>".
- **Status:** ✅ verified on device — Annual → "Buy annual — US$89.99", etc.

### Note — "Real conversation with Camille…" subtitle
- Not a bug. Hardcoded marketing copy in `src/app/paywall.tsx` (subtitle, ~line 168):
  `` `Real conversation with ${personaName}. No flashcards. 10 minutes a day.` ``
