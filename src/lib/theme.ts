/**
 * Parlez theme — warm, calm, conversation-first.
 * Marie's bubbles use a soft sand surface; the user's use the indigo accent.
 * Every colour comes from here; nothing hard-codes a hex value.
 */
import { useColorScheme } from '@/hooks/use-color-scheme';

const light = {
  background: '#FBF9F6',
  surface: '#FFFFFF',
  surfaceMuted: '#F1ECE4',

  text: '#1F1B16',
  textSecondary: '#6B635A',
  textFaint: '#A89E92',

  marieBubble: '#F1ECE4',
  marieBubbleText: '#2A2620',
  userBubble: '#5B6CB8',
  userBubbleText: '#FFFFFF',

  accent: '#5B6CB8',
  accentSoft: '#E7E9F4',
  onAccent: '#FFFFFF',

  correctionBg: '#FFF8E8',
  correctionBorder: '#E8D9A8',
  correctionArrow: '#C2872E',

  border: '#E8E2D8',
  error: '#C2483B',
  success: '#3E8E5A',

  waveform: '#5B6CB8',
  waveformMuted: '#CFCABF',
  scrim: 'rgba(0,0,0,0.35)',
};

const dark: typeof light = {
  background: '#15130F',
  surface: '#1E1B16',
  surfaceMuted: '#2A2620',

  text: '#F4EFE7',
  textSecondary: '#A89E90',
  textFaint: '#6B6358',

  marieBubble: '#2A2620',
  marieBubbleText: '#F0EBE2',
  userBubble: '#5B6CB8',
  userBubbleText: '#FFFFFF',

  accent: '#8A98D8',
  accentSoft: '#2A2D3D',
  onAccent: '#FFFFFF',

  correctionBg: '#2C2718',
  correctionBorder: '#4A4126',
  correctionArrow: '#D9A94A',

  border: '#332E26',
  error: '#E5736A',
  success: '#5FB07E',

  waveform: '#8A98D8',
  waveformMuted: '#3A352D',
  scrim: 'rgba(0,0,0,0.55)',
};

export const Palette = { light, dark } as const;
export type ThemeColors = typeof light;
export type ThemeMode = 'light' | 'dark';

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const Radius = {
  sm: 8,
  md: 14,
  lg: 22,
  xl: 28,
  pill: 999,
} as const;

export const FontSize = {
  caption: 13,
  body: 16,
  bubble: 17,
  title: 22,
  display: 30,
} as const;

export function useTheme(): { colors: ThemeColors; mode: ThemeMode } {
  const scheme = useColorScheme();
  const mode: ThemeMode = scheme === 'dark' ? 'dark' : 'light';
  return { colors: Palette[mode], mode };
}
