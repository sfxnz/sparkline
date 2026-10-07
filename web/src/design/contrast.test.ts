// WCAG 2.2 AA contrast for the token pairs actually used, computed from tokens.css itself.
// Text needs >= 4.5:1, non-text UI (status dots, focus ring, chart accent, control fills) >= 3:1.
// Translucent tokens are composited over the surface they sit on; materials are checked via their opaque
// surface (which is also their reduced-transparency fallback).
import css from './tokens.css?raw';

type RGBA = [number, number, number, number];

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`missing block ${selector}`);
  const open = css.indexOf('{', start);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1] ?? ''] = (m[2] ?? '').trim();
  return out;
}

function parse(v: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1]) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgba?.[1]) {
    const [r = 0, g = 0, b = 0, a = 1] = rgba[1].split(',').map((x) => parseFloat(x));
    return [r, g, b, a];
  }
  throw new Error(`unparseable colour ${v}`);
}

const over = (fg: RGBA, bg: RGBA): RGBA => {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
};

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const dark = block(":root[data-theme='dark']");
const themes = { dark, light: { ...dark, ...block(":root[data-theme='light']") } };

const SURFACES = ['bg', 'surface-1', 'surface-2', 'surface-3'];
const TEXT = ['text-1', 'text-2', 'text-3', 'accent-text', 'ok-text', 'warn-text', 'crit-text', 'stale-text'];
const NON_TEXT = ['accent', 'focus-ring', 'ok', 'warn', 'crit', 'stale', 'chart-1', 'chart-2', 'chart-3', 'heat-1', 'heat-2', 'heat-3', 'heat-4'];
const HEAT = ['heat-0', 'heat-1', 'heat-2', 'heat-3', 'heat-4'];
const STATUS = ['ok', 'warn', 'crit', 'stale'];

describe.each(Object.entries(themes))('%s theme contrast', (_name, t) => {
  const c = (name: string): RGBA => parse(t[name] ?? `missing --${name}`);
  const solid = (name: string, on: RGBA) => over(c(name), on);

  it.each(SURFACES.flatMap((s) => TEXT.map((x) => [x, s])))('text %s on %s >= 4.5', (fg, bg) => {
    const base = solid(bg, c('bg'));
    expect(contrast(solid(fg, base), base)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES.flatMap((s) => NON_TEXT.map((x) => [x, s])))('non-text %s on %s >= 3', (fg, bg) => {
    const base = solid(bg, c('bg'));
    expect(contrast(solid(fg, base), base)).toBeGreaterThanOrEqual(3);
  });

  it.each(STATUS.flatMap((s) => ['surface-1', 'surface-2', 'surface-3'].map((b) => [s, b])))(
    '%s-text on %s-bg tint over %s >= 4.5',
    (s, b) => {
      const tinted = solid(`${s}-bg`, solid(b, c('bg')));
      expect(contrast(solid(`${s}-text`, tinted), tinted)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('the heat ramp is perceptually ordered: each stop further from the surface than the last', () => {
    const base = solid('surface-2', c('bg'));
    const steps = HEAT.map((h) => contrast(c(h), base));
    steps.slice(1).forEach((x, i) => { expect(x).toBeGreaterThan((steps[i] ?? 0) * 1.4); });
  });

  it('text on accent fill (primary button) >= 4.5, including hover', () => {
    expect(contrast(c('text-on-accent'), c('accent-fill'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c('text-on-accent'), c('accent-fill-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  it('accent text on accent-soft tint >= 4.5 (selected nav item)', () => {
    const tinted = solid('accent-soft', solid('surface-1', c('bg')));
    expect(contrast(solid('accent-text', tinted), tinted)).toBeGreaterThanOrEqual(4.5);
  });

});
