import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
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
  SpeechBubble,
  ThinkingIndicator,
  Waveform,
  type WaveformMode,
} from '@/components';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useNetwork } from '@/lib/useNetwork';
import { useTurnEngine } from '@/lib/turnStateMachine';
import type { Message, TurnState } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

function waveformModeFor(turnState: TurnState): WaveformMode {
  if (turnState === 'marie_speaking') return 'marie';
  if (turnState === 'listening' || turnState === 'recording') return 'user';
  return 'idle';
}

function MessageRow({ message }: { message: Message }) {
  return (
    <View>
      <SpeechBubble speaker={message.speaker} text={message.text} faint={message.pending} />
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

  const { micLevel, onMicPress, submitText } = useTurnEngine(online);

  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState('');

  const listRef = useRef<FlatList<Message>>(null);
  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageRow message={item} />,
    [],
  );

  const waveMode = useMemo(() => waveformModeFor(turnState), [turnState]);

  // Android: pressing back during a conversation confirms first (spec §9.2).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert('End conversation?', 'Marie will be here when you come back.', [
        { text: 'Stay', style: 'cancel' },
        { text: 'End', style: 'destructive', onPress: () => BackHandler.exitApp() },
      ]);
      return true;
    });
    return () => sub.remove();
  }, []);

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    submitText(text);
    setDraft('');
    setTextMode(false);
  };

  const banner = errorNotice ?? (!online ? 'You’re offline — full conversation needs internet.' : null);
  const bannerIsError = errorNotice != null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <MarieHeader onSettingsPress={() => router.push('/settings')} />

      {banner ? (
        <Pressable
          onPress={() => bannerIsError && setErrorNotice(null)}
          accessibilityRole={bannerIsError ? 'button' : 'text'}
          style={[
            styles.banner,
            {
              backgroundColor: bannerIsError ? colors.error : colors.accentSoft,
              borderBottomColor: bannerIsError ? colors.error : colors.accent,
            },
          ]}>
          <Text
            style={[
              styles.bannerText,
              {
                color: bannerIsError ? colors.onAccent : colors.accent,
                fontWeight: bannerIsError ? '500' : '600',
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
            <Pressable
              onPress={() => setTextMode(false)}
              accessibilityRole="button"
              accessibilityLabel="Close text input"
              hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
        ) : (
          <Waveform mode={waveMode} level={micLevel} />
        )}
          <MicButton
            turnState={turnState}
            onPress={onMicPress}
            onLongPress={() => setTextMode(true)}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * The conversation screen — the entire app (spec §4.1). One screen: Marie's
 * header, the scrolling transcript, the waveform, and the mic button.
 */
export default function Conversation() {
  const sessionEpoch = useAppStore((s) => s.sessionEpoch);
  return <ConversationSession key={sessionEpoch} />;
}

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
