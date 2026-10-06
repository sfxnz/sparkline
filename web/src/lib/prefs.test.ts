import { DEFAULT_PREFS, loadPrefs, nextTheme, PREFS_KEY, savePrefs } from './prefs';

describe('prefs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('round-trips and validates', () => {
    savePrefs({ theme: 'light', reduceTransparency: true, sidebarCollapsed: true, timeRange: '24h', singleKeyShortcuts: false });
    expect(loadPrefs()).toEqual({ theme: 'light', reduceTransparency: true, sidebarCollapsed: true, timeRange: '24h', singleKeyShortcuts: false });
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'neon', timeRange: '3y', reduceTransparency: 'yes' }));
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('survives corrupt or unavailable storage', () => {
    localStorage.setItem(PREFS_KEY, '{oops');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(() => { savePrefs(DEFAULT_PREFS); }).not.toThrow();
  });
});

describe('nextTheme', () => {
  it('flips the visible appearance on every press and returns to following the system', () => {
    expect(nextTheme('system', 'dark')).toBe('light');
    expect(nextTheme('light', 'dark')).toBe('system');
    expect(nextTheme('system', 'light')).toBe('dark');
    expect(nextTheme('dark', 'light')).toBe('system');
    expect(nextTheme('dark', 'dark')).toBe('light'); // explicit override equal to system
  });
});
