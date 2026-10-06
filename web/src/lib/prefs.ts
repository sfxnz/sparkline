// Local preferences. Storage can be unavailable (private mode, blocked site data), so every access is guarded.
// The storage key and theme fields are also read by the inline script in index.html.

export type ThemePref = 'system' | 'dark' | 'light';
export type TimeRange = 'live' | '5m' | '1h' | '24h' | '7d';

export interface Prefs {
  theme: ThemePref;
  reduceTransparency: boolean;
  sidebarCollapsed: boolean;
  timeRange: TimeRange;
  /** Shortcuts without a modifier (G O, 1–9, T, W, ?). Can be turned off (WCAG 2.1.4). */
  singleKeyShortcuts: boolean;
}

export const PREFS_KEY = 'sparkline.prefs';
export const DEFAULT_PREFS: Prefs = { theme: 'system', reduceTransparency: false, sidebarCollapsed: false, timeRange: 'live', singleKeyShortcuts: true };

const THEMES: readonly ThemePref[] = ['system', 'dark', 'light'];
export const TIME_RANGES: readonly TimeRange[] = ['live', '5m', '1h', '24h', '7d'];

export function loadPrefs(): Prefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    theme: THEMES.includes(p.theme as ThemePref) ? (p.theme as ThemePref) : DEFAULT_PREFS.theme,
    reduceTransparency: p.reduceTransparency === true,
    sidebarCollapsed: p.sidebarCollapsed === true,
    timeRange: TIME_RANGES.includes(p.timeRange as TimeRange) ? (p.timeRange as TimeRange) : DEFAULT_PREFS.timeRange,
    singleKeyShortcuts: p.singleKeyShortcuts !== false,
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: preferences last for this session only */
  }
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * The theme a "toggle theme" action moves to. Every press flips the visible appearance; an override that would
 * match the system appearance becomes 'system' again, so the app goes back to following the OS.
 */
export function nextTheme(pref: ThemePref, systemTheme: 'dark' | 'light' = resolveTheme('system')): ThemePref {
  const shown = pref === 'system' ? systemTheme : pref;
  const flipped = shown === 'dark' ? 'light' : 'dark';
  return flipped === systemTheme ? 'system' : flipped;
}

/** Apply theme + transparency preference to <html> (same attributes the inline boot script sets). */
export function applyPrefsToDocument(prefs: Prefs): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveTheme(prefs.theme));
  root.toggleAttribute('data-reduce-transparency', prefs.reduceTransparency);
}
