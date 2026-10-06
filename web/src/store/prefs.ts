import { create } from 'zustand';
import { applyPrefsToDocument, loadPrefs, nextTheme, savePrefs, type Prefs } from '../lib/prefs';

interface PrefsStore extends Prefs {
  set: (patch: Partial<Prefs>) => void;
  cycleTheme: () => void;
}

const pick = (s: PrefsStore): Prefs => ({
  theme: s.theme,
  reduceTransparency: s.reduceTransparency,
  sidebarCollapsed: s.sidebarCollapsed,
  timeRange: s.timeRange,
  singleKeyShortcuts: s.singleKeyShortcuts,
});

export const usePrefs = create<PrefsStore>()((set, get) => ({
  ...loadPrefs(),
  set: (patch) => {
    set(patch);
    const prefs = pick(get());
    savePrefs(prefs);
    applyPrefsToDocument(prefs);
  },
  cycleTheme: () => {
    get().set({ theme: nextTheme(get().theme) });
  },
}));

/** Keep data-theme in sync with the OS while the preference is 'system'. Returns an unsubscribe function. */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const mq = matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    applyPrefsToDocument(pick(usePrefs.getState()));
  };
  mq.addEventListener('change', onChange);
  return () => {
    mq.removeEventListener('change', onChange);
  };
}
