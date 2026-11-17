import { Lightbulb, Play, Ruler } from 'lucide-react';
import { buildGuide, GUIDE_GROUPS, GUIDE_ITEMS, type GuideContext, type GuideItem } from './items';

const live = (id: string) => ({ node_id: id, status: 'online' as const, first_seen: 100 });
const refused = (id: string) => ({ node_id: id, status: 'offline' as const, first_seen: null });
const connecting = (id: string) => ({ node_id: id, status: 'connecting' as const, first_seen: null });
const ctx = (p: Partial<GuideContext> = {}): GuideContext => ({ nodes: [live('spark1')], servers: [], notifyChannels: 0, benchRuns: 0, seen: new Set(), ...p });
const row = (id: string, c: GuideContext) => {
  const found = buildGuide(c).rows.find((r) => r.item.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
};

/** The rows other branches add for 0.3.0: each is one object, as it would be written in GUIDE_ITEMS. */
const LATER: readonly GuideItem[] = [
  { id: 'fit', group: 'try', title: 'Will it fit?', blurb: 'See if a Hugging Face model fits a node before you download it.', icon: Ruler, since: '0.3.0', to: () => '/fit' },
  { id: 'serve-recipe', group: 'new', title: 'Serve a recipe', blurb: 'Start a tuned model server on a node with one click.', icon: Play, since: '0.3.0', to: () => '/recipes' },
  { id: 'recommendations', group: 'new', title: 'Recommendations', blurb: 'Community settings, checked against each of your nodes.', icon: Lightbulb, since: '0.3.0', to: () => '/recommendations' },
];

describe('the guide table', () => {
  it('has unique kebab-case ids and a real route for every row', () => {
    const ids = GUIDE_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of GUIDE_ITEMS) {
      expect(item.id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(item.to(ctx())).toMatch(/^\//);
      expect(GUIDE_GROUPS.map((g) => g.id)).toContain(item.group);
    }
  });

  it('draws five rows in three groups today, in the order a person would take them', () => {
    const g = buildGuide(ctx());
    expect(g.sections.map((s) => [s.label, s.rows.map((r) => r.item.id)])).toEqual([
      ['Set up', ['connect-nodes', 'notifications']],
      ['Already on', ['model-servers', 'prometheus']],
      ['Try it', ['benchmarks']],
    ]);
    expect(g.total).toBe(5);
  });

  it('takes a new row as one object: eight rows make four groups, and the new group names its release', () => {
    const g = buildGuide(ctx(), [...GUIDE_ITEMS, ...LATER]);
    expect(g.total).toBe(8);
    expect(g.sections.map((s) => [s.label, s.rows.length])).toEqual([['Set up', 2], ['Already on', 2], ['Try it', 2], ['New in 0.3.0', 2]]);
    // With nothing to derive it from, a row is done once the person has opened it.
    expect(buildGuide(ctx({ seen: new Set(['fit']) }), [...GUIDE_ITEMS, ...LATER]).rows.find((r) => r.item.id === 'fit')?.done).toBe(true);
  });

  it('does not draw a group that has no rows', () => {
    const g = buildGuide(ctx(), GUIDE_ITEMS.filter((i) => i.group !== 'on'));
    expect(g.sections.map((s) => s.label)).toEqual(['Set up', 'Try it']);
  });
});

describe('what is done comes from the cluster, not from clicks', () => {
  it('connect-nodes: done when every node has reported; until then it says who is missing and links to their fix', () => {
    expect(row('connect-nodes', ctx())).toMatchObject({ done: true, tag: null, to: '/', blurb: 'spark1 is live. More nodes go in `console.toml`.' });
    expect(row('connect-nodes', ctx({ nodes: [live('spark1'), live('spark2')] })).blurb).toBe('All 2 nodes are live.');
    expect(row('connect-nodes', ctx({ nodes: [connecting('spark1')] }))).toMatchObject({ done: false, blurb: 'Waiting for the first reading from spark1.', to: '/node/spark1' });
    expect(row('connect-nodes', ctx({ nodes: [live('spark1'), refused('spark2'), refused('spark3')] }))).toMatchObject({
      done: false, tag: '1 of 3', to: '/node/spark2', blurb: 'Waiting for spark2 and spark3. Their cards say what to check.',
    });
    expect(row('connect-nodes', ctx({ nodes: [refused('spark1')] }))).toMatchObject({ tag: null, blurb: 'Waiting for spark1. Its card says what to check.' });
    // Opening the row does not tick it.
    expect(row('connect-nodes', ctx({ nodes: [refused('spark1')], seen: new Set(['connect-nodes']) })).done).toBe(false);
  });

  it('notifications: done when the console has a channel', () => {
    expect(row('notifications', ctx())).toMatchObject({ done: false, tag: null, to: '/alerts#notifications' });
    expect(row('notifications', ctx({ notifyChannels: null })).done).toBe(false);
    expect(row('notifications', ctx({ notifyChannels: 2 }))).toMatchObject({ done: true, tag: '2 channels' });
  });

  it('model-servers: done when an agent found one, named from what it found', () => {
    expect(row('model-servers', ctx())).toMatchObject({ done: false, tag: null, to: '/node/spark1' });
    const found = row('model-servers', ctx({ nodes: [live('spark1'), live('spark2')], servers: [{ node: 'spark2', name: 'Qwen3-32B-AWQ' }] }));
    expect(found).toMatchObject({ done: true, tag: '1 found', to: '/node/spark2', blurb: 'Qwen3-32B-AWQ on spark2. Requests and speed are on the node’s page.' });
    // No server anywhere: looking at the page is all there is to do.
    expect(row('model-servers', ctx({ seen: new Set(['model-servers']) })).done).toBe(true);
  });

  it('prometheus: nothing to derive, so done once opened', () => {
    expect(row('prometheus', ctx())).toMatchObject({ done: false, to: '/settings#prometheus' });
    expect(row('prometheus', ctx({ seen: new Set(['prometheus']) })).done).toBe(true);
  });

  it('benchmarks: done when a run exists', () => {
    expect(row('benchmarks', ctx()).done).toBe(false);
    expect(row('benchmarks', ctx({ benchRuns: 1 })).done).toBe(true);
  });

  it('counts what is done and names the next row', () => {
    const g = buildGuide(ctx({ servers: [{ node: 'spark1', name: 'm' }] }));
    expect([g.done, g.total, g.next?.item.id]).toEqual([2, 5, 'notifications']);
    const all = buildGuide(ctx({ servers: [{ node: 'spark1', name: 'm' }], notifyChannels: 1, benchRuns: 1, seen: new Set(['prometheus']) }));
    expect([all.done, all.next]).toEqual([5, null]);
  });
});
