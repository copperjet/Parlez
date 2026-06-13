import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CorrectionCard,
  MarieHeader,
  MicButton,
  SignInNudge,
  SpeechBubble,
  ThinkingIndicator,
  Waveform,
  type WaveformMode,
} from '@/components';
import { PaywallGate } from '@/components/PaywallGate';
import { voiceName } from '@/lib/constants';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useNetwork } from '@/lib/useNetwork';
import { useTurnEngine } from '@/lib/turnStateMachine';
import type { Message, TurnState } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

function waveformModeFor(turnState: TurnState): WaveformMode {
  if (turnState === 'marie_speaking') return 'marie';
  if (turnState === 'listening' || turnState === 'recording') return 'user';
  return 'idle';
}

function MessageRow({
  message,
  onReplay,
}: {
  message: Message;
  onReplay: (text: string) => void;
}) {
  return (
    <View>
      <SpeechBubble
        speaker={message.speaker}
        text={message.text}
        translation={message.translation}
        segments={message.segments}
        faint={message.pending}
        onReplay={message.speaker === 'marie' ? () => onReplay(message.text) : undefined}
      />
      {message.corrections?.map((c, i) => (
        <CorrectionCard key={`${message.id}-c${i}`} correction={c} />
      ))}
    </View>
  );
}

/**
 * One conversation session. Hosts the turn engine — remounting it (via the
 * sessionEpoch key) cleanly restarts the conversation after a memory reset.
 */
function ConversationSession() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useNetwork();

  const messages = useAppStore((s) => s.messages);
  const turnState = useAppStore((s) => s.turnState);
  const liveTranscript = useAppStore((s) => s.liveTranscript);
  const errorNotice = useAppStore((s) => s.errorNotice);
  const setErrorNotice = useAppStore((s) => s.setErrorNotice);

  const { micLevel, onMicPress, submitText, sttUnavailable, replay } = useTurnEngine(online);
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState('');

  // No native speech recognizer (Expo Go / web): converse by typing. Keep the
  // text input open so the mic is never a dead-end.
  useEffect(() => {
    if (sttUnavailable) setTextMode(true);
  }, [sttUnavailable]);

  const listRef = useRef<FlatList<Message>>(null);
  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageRow message={item} onReplay={replay} />,
    [replay],
  );

  const waveMode = useMemo(() => waveformModeFor(turnState), [turnState]);

  // Android: pressing back during a conversation confirms first (spec §9.2).
  // Focus-scoped: when a modal (settings/account/…) is on top this screen is
  // unfocused, so back there pops the modal instead of prompting to end.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        Alert.alert('End conversation?', `${personaName} will be here when you come back.`, [
          { text: 'Stay', style: 'cancel' },
          { text: 'End', style: 'destructive', onPress: () => BackHandler.exitApp() },
        ]);
        return true;
      });
      return () => sub.remove();
    }, [personaName]),
  );

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    submitText(text);
    setDraft('');
    if (!sttUnavailable) setTextMode(false);
  };

  const banner =
    errorNotice ??
    (sttUnavailable
      ? `Voice needs the full Parlez app — type to chat with ${personaName} here.`
      : null) ??
    (!online ? 'You’re offline — full conversation needs internet.' : null);
  const bannerIsError = errorNotice != null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <MarieHeader onSettingsPress={() => router.push('/settings')} />

      <SignInNudge />

      {banner ? (
        <Pressable
          onPress={() => bannerIsError && setErrorNotice(null)}
          accessibilityRole={bannerIsError ? 'button' : 'text'}
          style={[
            styles.banner,
            {
              backgroundColor: bannerIsError ? colors.warningBg : colors.accentSoft,
              borderBottomColor: bannerIsError ? colors.warningBorder : colors.accent,
            },
          ]}>
          <Text
            style={[
              styles.bannerText,
              {
                color: bannerIsError ? colors.warningText : colors.accent,
                fontWeight: '600',
              },
            ]}>
            {banner}
          </Text>
        </Pressable>
      ) : null}

      <KeyboardAvoidingView
        style={styles.listFlex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          onContentSizeChange={scrollToEnd}
          style={styles.listFlex}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={turnState === 'processing' ? <ThinkingIndicator /> : null}
        />

        {liveTranscript ? (
          <Text style={[styles.live, { color: colors.textFaint }]} numberOfLines={2}>
            {liveTranscript}
          </Text>
        ) : null}

        <View
          style={[
            styles.dock,
            { borderTopColor: colors.border, paddingBottom: insets.bottom + Spacing.md },
          ]}>
          {textMode ? (
          <View style={styles.textRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type in French…"
              placeholderTextColor={colors.textFaint}
              style={[
                styles.textInput,
                { backgroundColor: colors.surfaceMuted, color: colors.text },
              ]}
              autoFocus
              onSubmitEditing={sendDraft}
              returnKeyType="send"
              accessibilityLabel="Type your response"
            />
            <Pressable
              onPress={sendDraft}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.sendBtn, { backgroundColor: colors.accent }]}>
              <Ionicons name="arrow-up" size={22} color={colors.onAccent} />
            </Pressable>
            {sttUnavailable ? null : (
              <Pressable
                onPress={() => setTextMode(false)}
                accessibilityRole="button"
                accessibilityLabel="Close text input"
                hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        ) : (
          <Waveform mode={waveMode} level={micLevel} />
        )}
          <MicButton
            turnState={sttUnavailable ? 'idle' : turnState}
            onPress={sttUnavailable ? () => setTextMode(true) : onMicPress}
            onLongPress={() => setTextMode(true)}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * Sheet that overlays the conversation when the user has hit their daily cap.
 * Upgrade path is the primary CTA (Hormozi: the cap is the offer).
 */
function CapSheet() {
  const { colors } = useTheme();
  const router = useRouter();
  const capBlocked = useSubscriptionStore((s) => s.capBlocked);
  const tier = useSubscriptionStore((s) => s.capBlockedTier);
  const capSeconds = useSubscriptionStore((s) => s.tierCapSeconds);
  const clear = useSubscriptionStore((s) => s.clearCapBlocked);

  if (!capBlocked || !tier) return null;

  const capMinutes = capSeconds ? Math.round(capSeconds / 60) : 30;
  const headline =
    tier === 'monthly'
      ? `You've used your daily ${capMinutes} minutes.`
      : `You've reached today's ${capMinutes} minute limit.`;
  const sub =
    tier === 'monthly'
      ? 'Annual unlocks 90 minutes a day — three times the practice for less than half the monthly rate.'
      : 'Come back tomorrow, or upgrade to Lifetime for unlimited practice.';
  const ctaLabel = tier === 'monthly' ? 'Upgrade to Annual' : 'See Lifetime';

  return (
    <View style={[capStyles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
      <View style={[capStyles.sheet, { backgroundColor: colors.surface }]}>
        <Text style={[capStyles.title, { color: colors.text }]}>{headline}</Text>
        <Text style={[capStyles.sub, { color: colors.textSecondary }]}>{sub}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          onPress={() => {
            clear();
            router.push(('/paywall?reason=cap') as never);
          }}
          style={[capStyles.cta, { backgroundColor: colors.accent }]}>
          <Text style={[capStyles.ctaText, { color: colors.onAccent }]}>{ctaLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue tomorrow"
          onPress={clear}
          hitSlop={8}
          style={capStyles.dismiss}>
          <Text style={[capStyles.dismissText, { color: colors.textSecondary }]}>
            Continue tomorrow
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The conversation screen — the entire app (spec §4.1). One screen: Marie's
 * header, the scrolling transcript, the waveform, and the mic button.
 */
export default function Conversation() {
  const sessionEpoch = useAppStore((s) => s.sessionEpoch);
  return (
    <PaywallGate>
      <ConversationSession key={sessionEpoch} />
      <CapSheet />
    </PaywallGate>
  );
}

const capStyles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: {
    alignSelf: 'stretch',
    margin: Spacing.lg,
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.sm,
  },
  title: { fontSize: FontSize.bubble, fontWeight: '700' },
  sub: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.4 },
  cta: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  ctaText: { fontSize: FontSize.body, fontWeight: '700' },
  dismiss: { alignItems: 'center', paddingVertical: Spacing.sm },
  dismissText: { fontSize: FontSize.caption, fontWeight: '500' },
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listFlex: { flex: 1 },
  list: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  banner: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: { fontSize: FontSize.caption, textAlign: 'center' },
  live: {
    fontSize: FontSize.caption,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  dock: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignSelf: 'stretch',
  },
  textInput: {
    flex: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    fontSize: FontSize.body,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
