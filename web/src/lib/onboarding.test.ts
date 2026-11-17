import { guideStage, guideView, isNewNode, mergeOnboarding, needsSetup } from './onboarding';
import type { Onboarding } from './types';

const ob = (over: Partial<Onboarding> = {}): Onboarding => ({ started: 100, finished: null, seen: [], ...over });

describe('new nodes', () => {
  it('a node is new only while the console says it has never answered', () => {
    expect(isNewNode({ first_seen: null })).toBe(true);
    expect(isNewNode({ first_seen: 1_700_000_000 })).toBe(false);
    // A console before 0.3.0 sends no first_seen: its nodes were set up long ago.
    expect(isNewNode({})).toBe(false);
    expect(isNewNode(undefined)).toBe(false);
  });

  it('a new node needs setup once the console has tried it and failed', () => {
    expect(needsSetup({ first_seen: null, status: 'offline' })).toBe(true);
    expect(needsSetup({ first_seen: null, status: 'error' })).toBe(true);
    expect(needsSetup({ first_seen: null, status: 'connecting' })).toBe(false);
    expect(needsSetup({ first_seen: 5, status: 'offline' })).toBe(false);
  });
});

describe('mergeOnboarding', () => {
  it('adds seen ids as a sorted set, and the same patch twice gives the same row', () => {
    const once = mergeOnboarding(ob({ seen: ['prometheus'] }), { seen: ['benchmarks', 'prometheus'] }, 200);
    expect(once.seen).toEqual(['benchmarks', 'prometheus']);
    expect(mergeOnboarding(once, { seen: ['benchmarks', 'prometheus'] }, 300)).toEqual(once);
  });

  it('stamps finished once, and false clears it', () => {
    const done = mergeOnboarding(ob(), { finished: true }, 200);
    expect(done.finished).toBe(200);
    expect(mergeOnboarding(done, { finished: true }, 300).finished).toBe(200);
    expect(mergeOnboarding(done, { finished: false }, 300).finished).toBeNull();
    expect(mergeOnboarding(done, { seen: ['x'] }, 300).finished).toBe(200);
  });
});

describe('the guide follows the console state', () => {
  it('is finished for an older console, before anyone signed in, and once completed or dismissed', () => {
    expect(guideStage(null)).toBe('finished');
    expect(guideStage(undefined)).toBe('finished');
    expect(guideStage(ob({ started: null }))).toBe('finished');
    expect(guideStage(ob({ finished: 150 }))).toBe('finished');
  });

  it('is a first visit until an item was opened, then resumed', () => {
    expect(guideStage(ob())).toBe('first');
    expect(guideStage(ob({ seen: ['prometheus'] }))).toBe('resumed');
  });

  it('draws the full panel first, one line when resumed, and nothing once finished', () => {
    expect(guideView('first', null)).toBe('full');
    expect(guideView('resumed', null)).toBe('strip');
    expect(guideView('finished', null)).toBe('gone');
  });

  it("this browser's Collapse and Show all win while the guide is unfinished, and never bring a finished one back", () => {
    expect(guideView('first', false)).toBe('strip');
    expect(guideView('resumed', true)).toBe('full');
    expect(guideView('finished', true)).toBe('gone');
  });
});
