import type { AlertRule } from '../../lib/types';
import { draftChanged, fromDisplay, fromDraft, GIB, maskReasons, ruleIdInError, toDisplay, toDraft, toggleBit, unitFor, validateDraft } from './rules';

const rule = (patch: Partial<AlertRule> = {}): AlertRule => ({
  id: 'gpu_temp_high', name: 'GPU temperature high', enabled: true, kind: 'threshold', metric: 'gpu0.temp_c', op: '>', threshold: 80, for_s: 30, severity: 'warning', nodes: null, ...patch,
});

describe('units', () => {
  it('maps keys to units like the console formats them', () => {
    expect(unitFor('gpu0.temp_c')).toBe('celsius');
    expect(unitFor('temp.mlx5.0')).toBe('celsius');
    expect(unitFor('mem.available')).toBe('gib');
    expect(unitFor('mem.psi_full')).toBe('percent');
    expect(unitFor('fs.data.used_pct')).toBe('percent');
    expect(unitFor('cpu.load1')).toBe('plain');
  });
  it('edits bytes in GiB and round-trips', () => {
    expect(toDisplay(8 * GIB, 'gib')).toBe('8');
    expect(toDisplay(1.5 * GIB, 'gib')).toBe('1.5');
    expect(fromDisplay('8', 'gib')).toBe(8 * GIB);
    expect(fromDisplay('0,5', 'gib')).toBe(GIB / 2);
    expect(fromDisplay('8 GiB', 'gib')).toBeNull();
    expect(fromDisplay('', 'plain')).toBeNull();
  });
});

describe('validateDraft', () => {
  it('accepts the defaults and rejects bad values with plain messages', () => {
    expect(validateDraft(toDraft(rule()))).toEqual({});
    expect(validateDraft({ ...toDraft(rule()), thresholdText: 'hot' }).threshold).toBe('Enter a number.');
    expect(validateDraft({ ...toDraft(rule()), thresholdText: '400' }).threshold).toBe('Use 0 to 150 °C.');
    expect(validateDraft({ ...toDraft(rule()), forText: '-1' }).for_s).toMatch(/0 to 86400/);
    expect(validateDraft(toDraft(rule({ name: '  ' }))).name).toBeDefined();
    expect(validateDraft(toDraft(rule({ metric: 'mem.used_pct', threshold: 101 }))).threshold).toBe('Use 0 to 100 %.');
  });
  it('requires at least one throttle reason', () => {
    const t = rule({ kind: 'throttle', metric: 'gpu0.throttle_mask', threshold: 0 });
    expect(validateDraft(toDraft(t)).mask).toBeDefined();
    expect(validateDraft(toDraft({ ...t, threshold: 0x20 }))).toEqual({});
  });
  it('node_offline / link_down only validate name and duration', () => {
    expect(validateDraft(toDraft(rule({ kind: 'node_offline', metric: null, threshold: null })))).toEqual({});
  });
});

describe('fromDraft / draftChanged', () => {
  it('converts display text back to wire values', () => {
    const d = toDraft(rule({ metric: 'mem.available', op: '<', threshold: 8 * GIB }));
    expect(fromDraft({ ...d, thresholdText: '12', forText: '45' })).toMatchObject({ threshold: 12 * GIB, for_s: 45 });
  });
  it('treats equal numbers as unchanged and edits as changed', () => {
    const saved = rule();
    expect(draftChanged({ ...toDraft(saved), thresholdText: '80.0' }, saved)).toBe(false);
    expect(draftChanged({ ...toDraft(saved), thresholdText: '81' }, saved)).toBe(true);
    expect(draftChanged(toDraft({ ...saved, enabled: false }), saved)).toBe(true);
    expect(draftChanged(toDraft(saved), undefined)).toBe(true);
  });
});

describe('throttle mask', () => {
  it('decodes into checkbox state and toggles bits', () => {
    const r = maskReasons(0x8 | 0x20 | 0x40 | 0x80);
    expect(r.filter((x) => x.checked).map((x) => x.title)).toEqual(['Hardware slowdown', 'Thermal limit', 'Overheating', 'Power brake']);
    expect(toggleBit(0xe8, 0x4, true)).toBe(0xec);
    expect(toggleBit(0xe8, 0x8, false)).toBe(0xe0);
    expect(toggleBit(null, 0x1, true)).toBe(1);
  });
});

it('finds the rule id in a validate_rules message', () => {
  expect(ruleIdInError("Invalid alert rules Rule 'disk_full': for_s must be >= 0")).toBe('disk_full');
  expect(ruleIdInError('Duplicate rule id \'x\'')).toBe('x');
  expect(ruleIdInError('nothing')).toBeNull();
});
