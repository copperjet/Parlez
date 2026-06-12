import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { voiceName } from '@/lib/constants';
import type { MessageSegment, Speaker } from '@/lib/types';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

interface SpeechBubbleProps {
  speaker: Speaker;
  text: string;
  /** Optional one-line English translation, revealed when the bubble is tapped. */
  translation?: string;
  /** Optional structured layout for a longer partner explanation. */
  segments?: MessageSegment[];
  /** Faint rendering for live, not-yet-final transcription (spec §3.3). */
  faint?: boolean;
  /** Re-hear this message — only provided for partner bubbles. */
  onReplay?: () => void;
}

/** Drop surrounding «guillemets» for use as a plain heading. */
function stripGuillemets(s: string): string {
  return s.replace(/^[«»\s]+|[«»\s]+$/g, '');
}

/**
 * Render text with «guillemet»-quoted French terms emphasised — Camille wraps
 * the vocabulary/examples she references in guillemets, so highlighting them
 * gives an otherwise-dense explanation visible structure. The guillemets
 * themselves are dropped; the inner term is shown bold in the accent colour.
 */
function HighlightedText({
  text,
  color,
  accent,
  style,
}: {
  text: string;
  color: string;
  accent: string;
  style: object[];
}) {
  const re = /«\s*([^«»]+?)\s*»/g;
  const parts: { t: string; hl: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), hl: false });
    parts.push({ t: m[1], hl: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), hl: false });
  if (parts.length === 0) parts.push({ t: text, hl: false });

  return (
    <Text style={[...style, { color }]}>
      {parts.map((p, i) =>
        p.hl ? (
          <Text key={i} style={{ color: accent, fontWeight: '600' }}>
            {p.t}
          </Text>
        ) : (
          p.t
        ),
      )}
    </Text>
  );
}

/**
 * One conversation bubble (spec §4.2). The partner sits left on a soft surface;
 * the user sits right on the accent colour. Text is shown exactly as spoken —
 * the user's own French is never silently corrected here.
 *
 * Partner bubbles stay French-first: tapping reveals a faint English translation
 * (when available), and a small replay button re-speaks the line.
 */
export function SpeechBubble({
  speaker,
  text,
  translation,
  segments,
  faint,
  onReplay,
}: SpeechBubbleProps) {
  const { colors } = useTheme();
  const personaName = voiceName(useAppStore((s) => s.settings.voice));
  const isMarie = speaker === 'marie';
  const [showTranslation, setShowTranslation] = useState(false);

  const bg = isMarie ? colors.marieBubble : colors.userBubble;
  const fg = isMarie ? colors.marieBubbleText : colors.userBubbleText;
  const canTranslate = isMarie && !!translation;
  // Highlight vocabulary only on the partner's muted bubble — on the user's
  // accent-coloured bubble the accent emphasis would be invisible.
  const accent = isMarie ? colors.accent : fg;
  const hasSegments = isMarie && !!segments && segments.length > 0;

  // Typewriter reveal for new Camille bubbles — words appear progressively so the
  // reply feels live rather than snapping in all at once. Skipped for pending/faint
  // bubbles and segment-structured explanations (already visually broken up).
  const [displayText, setDisplayText] = useState(text);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didAnimateRef = useRef(false);
  useEffect(() => {
    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    if (!isMarie || faint || hasSegments || didAnimateRef.current) {
      setDisplayText(text);
      return;
    }
    didAnimateRef.current = true;
    const words = text.split(' ');
    let i = 0;
    const step = () => {
      i += 1;
      setDisplayText(words.slice(0, i).join(' '));
      if (i < words.length) animTimerRef.current = setTimeout(step, 60);
    };
    step();
    return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); };
  }, [text, isMarie, faint, hasSegments]);

  const bubbleInner = (
    <>
      {hasSegments ? (
        <View style={styles.segments}>
          {segments!.map((seg, i) => (
            <View key={i}>
              {seg.label ? (
                <Text style={[styles.segmentLabel, { color: accent }]}>
                  {stripGuillemets(seg.label)}
                </Text>
              ) : null}
              <HighlightedText
                text={seg.text}
                color={fg}
                accent={accent}
                style={[styles.text]}
              />
            </View>
          ))}
        </View>
      ) : (
        <HighlightedText text={displayText} color={fg} accent={accent} style={[styles.text]} />
      )}
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
  segments: { gap: Spacing.sm },
  segmentLabel: {
    fontSize: FontSize.caption,
    fontWeight: '700',
    marginBottom: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
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
