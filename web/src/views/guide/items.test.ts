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
      expect(item.to(ctx({ nodes: [refused('spark1')] }))).toMatch(/^\//);
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

describe('a row is done when the person has opened it or the cluster’s own state shows it', () => {
  it('holds for every row but the one that asks for something to happen', () => {
    const nothingYet = ctx({ nodes: [refused('spark1')] });
    const opened = (id: string) => ctx({ nodes: [refused('spark1')], seen: new Set([id]) });
    for (const item of GUIDE_ITEMS) {
      expect(row(item.id, nothingYet).done, item.id).toBe(false);
      expect(row(item.id, opened(item.id)).done, item.id).toBe(item.id !== 'connect-nodes');
    }
    // Shown by the cluster, never opened.
    const shown = ctx({ servers: [{ node: 'spark1', name: 'm' }], notifyChannels: 1, benchRuns: 1 });
    expect(buildGuide(shown).rows.filter((r) => r.done).map((r) => r.item.id)).toEqual(['connect-nodes', 'notifications', 'model-servers', 'benchmarks']);
  });

  it('connect-nodes: done when every node has reported; until then it says who is missing and links to their fix', () => {
    // Done: the nodes are on the page the guide is on, so there is nothing to open.
    expect(row('connect-nodes', ctx())).toMatchObject({ done: true, tag: null, to: null, blurb: 'spark1 is live. More nodes go in `console.toml`.' });
    expect(row('connect-nodes', ctx({ nodes: [live('spark1'), live('spark2')] })).blurb).toBe('All 2 nodes are live.');
    expect(row('connect-nodes', ctx({ nodes: [connecting('spark1')] }))).toMatchObject({ done: false, blurb: 'Waiting for the first reading from spark1.', to: '/node/spark1' });
    expect(row('connect-nodes', ctx({ nodes: [live('spark1'), refused('spark2'), refused('spark3')] }))).toMatchObject({
      done: false, tag: '1 of 3', to: '/node/spark2', blurb: 'Waiting for spark2 and spark3. Their cards say what to do.',
    });
    expect(row('connect-nodes', ctx({ nodes: [refused('spark1')] }))).toMatchObject({ tag: null, blurb: 'Waiting for spark1. Its card says what to do.' });
    // Opening the row does not tick it: the node still has to answer.
    expect(row('connect-nodes', ctx({ nodes: [refused('spark1')], seen: new Set(['connect-nodes']) })).done).toBe(false);
  });

  it('notifications: done when the console has a channel, or once opened', () => {
    expect(row('notifications', ctx())).toMatchObject({ done: false, tag: null, to: '/alerts#notifications' });
    expect(row('notifications', ctx({ notifyChannels: null })).done).toBe(false);
    expect(row('notifications', ctx({ notifyChannels: 2 }))).toMatchObject({ done: true, tag: '2 channels' });
    expect(row('notifications', ctx({ seen: new Set(['notifications']) }))).toMatchObject({ done: true, tag: null });
  });

  it('model-servers: done when an agent found one, named from what it found, or once opened', () => {
    expect(row('model-servers', ctx())).toMatchObject({ done: false, tag: null, to: '/node/spark1#model-servers' });
    const found = row('model-servers', ctx({ nodes: [live('spark1'), live('spark2')], servers: [{ node: 'spark2', name: 'Qwen3-32B-AWQ' }] }));
    expect(found).toMatchObject({ done: true, tag: '1 found', to: '/node/spark2#model-servers', blurb: 'Qwen3-32B-AWQ on spark2. Requests and speed are on the node’s page.' });
    expect(row('model-servers', ctx({ seen: new Set(['model-servers']) })).done).toBe(true);
  });

  it('prometheus: nothing to derive, so done once opened', () => {
    expect(row('prometheus', ctx())).toMatchObject({ done: false, to: '/settings#prometheus' });
    expect(row('prometheus', ctx({ seen: new Set(['prometheus']) })).done).toBe(true);
  });

  it('benchmarks: done when a run exists, or once opened', () => {
    expect(row('benchmarks', ctx()).done).toBe(false);
    expect(row('benchmarks', ctx({ benchRuns: 1 })).done).toBe(true);
    expect(row('benchmarks', ctx({ seen: new Set(['benchmarks']) })).done).toBe(true);
  });

  it('counts what is done and names the next row, which moves on as rows are opened', () => {
    const g = buildGuide(ctx({ servers: [{ node: 'spark1', name: 'm' }] }));
    expect([g.done, g.total, g.next?.item.id]).toEqual([2, 5, 'notifications']);
    const afterAlerts = buildGuide(ctx({ servers: [{ node: 'spark1', name: 'm' }], seen: new Set(['notifications']) }));
    expect([afterAlerts.done, afterAlerts.next?.item.id]).toEqual([3, 'prometheus']);
    // Every page opened on a cluster with no channel and no run: the guide can finish.
    const all = buildGuide(ctx({ seen: new Set(['notifications', 'model-servers', 'prometheus', 'benchmarks']) }));
    expect([all.done, all.next]).toEqual([5, null]);
  });
});
