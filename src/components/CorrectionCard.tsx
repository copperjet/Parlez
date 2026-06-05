import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import type { Correction } from '@/lib/types';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';

/**
 * A compact, non-alarming inline correction (spec §4.3): what you said -> what
 * to say, with an optional one-line gloss. Appears directly below a Marie bubble.
 */
export function CorrectionCard({ correction }: { correction: Correction }) {
  const { colors } = useTheme();

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.correctionBg, borderColor: colors.correctionBorder },
        ]}
        accessibilityRole="text"
        accessibilityLabel={`Correction: instead of ${correction.original}, say ${correction.corrected}${
          correction.gloss ? `. ${correction.gloss}` : ''
        }`}>
        <View style={styles.line}>
          <Text style={[styles.original, { color: colors.textSecondary }]} numberOfLines={2}>
            {correction.original}
          </Text>
          <Ionicons name="arrow-forward" size={14} color={colors.correctionArrow} />
          <Text style={[styles.corrected, { color: colors.text }]} numberOfLines={2}>
            {correction.corrected}
          </Text>
        </View>
        {correction.gloss ? (
          <Text style={[styles.gloss, { color: colors.textSecondary }]}>
            {correction.gloss}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'flex-start', marginVertical: Spacing.xs },
  card: {
    maxWidth: '88%',
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flexWrap: 'wrap' },
  original: { fontSize: FontSize.caption, fontStyle: 'italic', flexShrink: 1 },
  corrected: { fontSize: FontSize.body, fontWeight: '600', flexShrink: 1 },
  gloss: { fontSize: FontSize.caption },
});
