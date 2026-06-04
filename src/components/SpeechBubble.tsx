import { StyleSheet, Text, View } from 'react-native';

import type { Speaker } from '@/lib/types';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';

interface SpeechBubbleProps {
  speaker: Speaker;
  text: string;
  /** Faint rendering for live, not-yet-final transcription (spec §3.3). */
  faint?: boolean;
}

/**
 * One conversation bubble (spec §4.2). Marie sits left on a soft surface;
 * the user sits right on the accent colour. Text is shown exactly as spoken —
 * the user's own French is never silently corrected here.
 */
export function SpeechBubble({ speaker, text, faint }: SpeechBubbleProps) {
  const { colors } = useTheme();
  const isMarie = speaker === 'marie';

  const bg = isMarie ? colors.marieBubble : colors.userBubble;
  const fg = isMarie ? colors.marieBubbleText : colors.userBubbleText;

  return (
    <View
      style={[styles.row, { justifyContent: isMarie ? 'flex-start' : 'flex-end' }]}
      accessibilityRole="text"
      accessibilityLabel={`${isMarie ? 'Marie' : 'You'} said: ${text}`}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: bg,
            borderBottomLeftRadius: isMarie ? Radius.sm : Radius.lg,
            borderBottomRightRadius: isMarie ? Radius.lg : Radius.sm,
            opacity: faint ? 0.55 : 1,
          },
        ]}>
        <Text style={[styles.text, { color: fg }]}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginVertical: Spacing.xs },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
  },
  text: { fontSize: FontSize.bubble, lineHeight: FontSize.bubble * 1.4 },
});
