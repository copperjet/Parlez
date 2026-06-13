/**
 * Parlez theme — warm, calm, conversation-first.
 * Marie's bubbles use a soft sand surface; the user's use the indigo accent.
 * Every colour comes from here; nothing hard-codes a hex value.
 *
 * Light/dark follows the device. On top of that the user picks a *chat theme*
 * (settings.chatTheme) — a curated accent family that recolours the user bubble,
 * accents and waveform. Surfaces stay the calm sand palette so text contrast and
 * Marie's bubble are never compromised. Theme ids/colours mirror the streak
 * flame tiers so the app feels of a piece.
 */
import type { ChatThemeId } from '@/lib/types';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useAppStore } from '@/stores/appStore';

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

  // Recoverable in-conversation notices (mic hiccup, STT miss) — a gentle
  // heads-up, deliberately softer than `error`.
  warningBg: '#FBF0DC',
  warningBorder: '#E8D9A8',
  warningText: '#7A5B22',

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

  warningBg: '#2C2718',
  warningBorder: '#4A4126',
  warningText: '#D9A94A',

  waveform: '#8A98D8',
  waveformMuted: '#3A352D',
  scrim: 'rgba(0,0,0,0.55)',
};

export type ThemeColors = typeof light;
export type ThemeMode = 'light' | 'dark';

/** The accent slots a chat theme overrides on top of the sand base. */
interface AccentFamily {
  accent: string;
  accentSoft: string;
  onAccent: string;
  userBubble: string;
  userBubbleText: string;
  waveform: string;
}

/** Apply an accent family to a base palette without touching surfaces/text. */
function withAccent(base: ThemeColors, a: AccentFamily): ThemeColors {
  return { ...base, ...a };
}

/**
 * Curated chat themes. Each is a full {light, dark} palette so it reads well in
 * both modes. `sand` is the original indigo default; the others mirror the
 * streak flame tiers (ember / cosmic violet / supernova blue).
 */
export const THEMES: Record<ChatThemeId, { light: ThemeColors; dark: ThemeColors }> = {
  sand: { light, dark },
  ember: {
    light: withAccent(light, {
      accent: '#D9622E',
      accentSoft: '#FBE7DA',
      onAccent: '#FFFFFF',
      userBubble: '#D9622E',
      userBubbleText: '#FFFFFF',
      waveform: '#D9622E',
    }),
    dark: withAccent(dark, {
      accent: '#F0925E',
      accentSoft: '#3A271C',
      onAccent: '#1F1206',
      userBubble: '#C9551F',
      userBubbleText: '#FFFFFF',
      waveform: '#F0925E',
    }),
  },
  violet: {
    light: withAccent(light, {
      accent: '#8B4FD6',
      accentSoft: '#EFE5FA',
      onAccent: '#FFFFFF',
      userBubble: '#8B4FD6',
      userBubbleText: '#FFFFFF',
      waveform: '#8B4FD6',
    }),
    dark: withAccent(dark, {
      accent: '#B98BE8',
      accentSoft: '#2E2440',
      onAccent: '#1A1026',
      userBubble: '#7E45C7',
      userBubbleText: '#FFFFFF',
      waveform: '#B98BE8',
    }),
  },
  supernova: {
    light: withAccent(light, {
      accent: '#2486E6',
      accentSoft: '#DCEDFC',
      onAccent: '#FFFFFF',
      userBubble: '#2486E6',
      userBubbleText: '#FFFFFF',
      waveform: '#2486E6',
    }),
    dark: withAccent(dark, {
      accent: '#5FB0F2',
      accentSoft: '#1C2C3D',
      onAccent: '#08182A',
      userBubble: '#1E78D6',
      userBubbleText: '#FFFFFF',
      waveform: '#5FB0F2',
    }),
  },
};

/** Picker metadata — id, label, and a representative swatch for each theme. */
export const THEME_OPTIONS: { id: ChatThemeId; label: string; swatch: string }[] = [
  { id: 'sand', label: 'Indigo', swatch: '#5B6CB8' },
  { id: 'ember', label: 'Ember', swatch: '#D9622E' },
  { id: 'violet', label: 'Violet', swatch: '#8B4FD6' },
  { id: 'supernova', label: 'Supernova', swatch: '#2486E6' },
];

/** Backwards-compatible default palette export (the sand theme). */
export const Palette = { light, dark } as const;

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
  const themeId = useAppStore((s) => s.settings.chatTheme);
  const mode: ThemeMode = scheme === 'dark' ? 'dark' : 'light';
  const family = THEMES[themeId] ?? THEMES.sand;
  return { colors: family[mode], mode };
}
