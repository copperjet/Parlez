import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { voiceName } from '@/lib/constants';
import type { Speaker } from '@/lib/types';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

interface SpeechBubbleProps {
  speaker: Speaker;
  text: string;
  /** Optional one-line English translation, revealed when the bubble is tapped. */
  translation?: string;
  /** Faint rendering for live, not-yet-final transcription (spec §3.3). */
  faint?: boolean;
  /** Re-hear this message — only provided for partner bubbles. */
  onReplay?: () => void;
}

/**
 * One conversation bubble (spec §4.2). The partner sits left on a soft surface;
 * the user sits right on the accent colour. Text is shown exactly as spoken —
 * the user's own French is never silently corrected here.
 *
 * Partner bubbles stay French-first: tapping reveals a faint English translation
 * (when available), and a small replay button re-speaks the line.
 */
export function SpeechBubble({ speaker, text, translation, faint, onReplay }: SpeechBubbleProps) {
  const { colors } = useTheme();
  const personaName = voiceName(useAppStore((s) => s.settings.voice));
  const isMarie = speaker === 'marie';
  const [showTranslation, setShowTranslation] = useState(false);

  const bg = isMarie ? colors.marieBubble : colors.userBubble;
  const fg = isMarie ? colors.marieBubbleText : colors.userBubbleText;
  const canTranslate = isMarie && !!translation;

  const bubbleInner = (
    <>
      <Text style={[styles.text, { color: fg }]}>{text}</Text>
      {canTranslate && showTranslation ? (
        <Text style={[styles.translation, { color: fg }]}>{translation}</Text>
      ) : null}
    </>
  );

  return (
    <View style={[styles.row, { justifyContent: isMarie ? 'flex-start' : 'flex-end' }]}>
      <View style={styles.stack}>
        {canTranslate ? (
          <Pressable
            onPress={() => setShowTranslation((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={`${personaName} said: ${text}. ${
              showTranslation ? 'Hide' : 'Show'
            } English translation.`}
            style={[
              styles.bubble,
              {
                backgroundColor: bg,
                borderBottomLeftRadius: Radius.sm,
                borderBottomRightRadius: Radius.lg,
                opacity: faint ? 0.55 : 1,
              },
            ]}>
            {bubbleInner}
          </Pressable>
        ) : (
          <View
            accessibilityRole="text"
            accessibilityLabel={`${isMarie ? personaName : 'You'} said: ${text}`}
            style={[
              styles.bubble,
              {
                backgroundColor: bg,
                borderBottomLeftRadius: isMarie ? Radius.sm : Radius.lg,
                borderBottomRightRadius: isMarie ? Radius.lg : Radius.sm,
                opacity: faint ? 0.55 : 1,
              },
            ]}>
            {bubbleInner}
          </View>
        )}

        {isMarie && onReplay && !faint ? (
          <Pressable
            onPress={onReplay}
            accessibilityRole="button"
            accessibilityLabel={`Replay ${personaName}'s message`}
            hitSlop={8}
            style={({ pressed }) => [styles.replay, pressed && { opacity: 0.5 }]}>
            <Ionicons name="volume-medium-outline" size={16} color={colors.textSecondary} />
            <Text style={[styles.replayLabel, { color: colors.textSecondary }]}>Replay</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginVertical: Spacing.xs },
  stack: { maxWidth: '82%', alignItems: 'flex-start' },
  bubble: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
  },
  text: { fontSize: FontSize.bubble, lineHeight: FontSize.bubble * 1.4 },
  translation: {
    fontSize: FontSize.caption,
    fontStyle: 'italic',
    lineHeight: FontSize.caption * 1.4,
    marginTop: Spacing.xs,
    opacity: 0.75,
  },
  replay: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.xs,
  },
  replayLabel: { fontSize: FontSize.caption },
});
