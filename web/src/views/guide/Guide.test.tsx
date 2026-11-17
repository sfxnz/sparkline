// The guide's three shapes follow the console's Onboarding, and everything it stores goes to the console.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Lightbulb, Play, Ruler } from 'lucide-react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { mergeOnboarding } from '../../lib/onboarding';
import type { ClusterState, NodeState, Onboarding, OnboardingPatch, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useGuideFacts } from '../../store/guide';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { useUi } from '../../store/ui';
import sampleJson from '../../test/fixtures/sample.json';
import { AboutSection } from '../settings/AboutSection';
import { Guide, GuideChip, GuideEntry } from './Guide';
import { GUIDE_ITEMS, type GuideItem } from './items';

const now = Date.now() / 1000;
const node = (id: string, p: Partial<NodeState> = {}): NodeState => ({
  node_id: id, url: 'http://192.168.1.11:9750', status: 'online', since: now, last_sample_ts: now, error: null, info: null, next_retry_ts: null, first_seen: now, ...p,
});
const cluster = (onboarding: Onboarding | undefined, nodes: NodeState[] = [node('spark1')]): ClusterState => ({
  nodes, settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 }, demo: false, version: 'test', server_time: now, onboarding,
});
const first: Onboarding = { started: now, finished: null, seen: [] };

/** A console: answers the two counts, and merges a PUT as the real one does. */
let sent: OnboardingPatch[] = [];
function consoleWith({ channels = 0, runs = 0 }: { channels?: number; runs?: number } = {}) {
  sent = [];
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : '';
    if (url.startsWith('/api/v1/notify/channels')) return json(Array.from({ length: channels }, (_, i) => ({ name: `c${i}` })));
    if (url.startsWith('/api/v1/bench/runs')) return json(Array.from({ length: runs }, (_, i) => ({ id: `r${i}` })));
    if (url === '/api/v1/onboarding') {
      const patch = JSON.parse(init?.body as string) as OnboardingPatch;
      sent.push(patch);
      return json(mergeOnboarding(useCluster.getState().onboarding ?? first, patch, now));
    }
    return json([]);
  });
}
function show(onboarding: Onboarding | undefined, opts: { nodes?: NodeState[]; items?: readonly GuideItem[]; path?: string } = {}) {
  useCluster.getState().setHello(cluster(onboarding, opts.nodes));
  const loc = memoryLocation({ path: opts.path ?? '/', record: true });
  render(<Router hook={loc.hook}><GuideChip /><Guide items={opts.items} /><GuideEntry collapsed={false} /><AboutSection /></Router>);
  return loc;
}
const panel = () => screen.getByRole('region', { name: 'Getting started' });
// jsdom has no layout, so Testing Library joins the text of sibling spans without the space a browser reads
// between them; the names below allow for it, and e2e/onboarding.spec.ts reads the real ones.
const strip = () => screen.getByRole('region', { name: /^Getting started, \d of \d done$/ });

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});
beforeEach(() => {
  useConnection.setState({ status: 'live', everLive: true });
  useGuideFacts.setState({ notifyChannels: null, benchRuns: null });
  useUi.setState({ guideWanted: false, guideLeft: null });
  usePrefs.setState({ guideOpen: null });
  liveStore.removeNode('spark1');
  consoleWith();
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('the guide follows the console', () => {
  it('shows every row, grouped, on a first visit', async () => {
    show(first);
    const p = panel();
    expect(within(p).getByText('Five things Sparkline does. Each one opens the real page, in any order.')).toBeInTheDocument();
    expect(within(p).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Set up', 'Already on', 'Try it']);
    expect(within(p).getAllByRole('link')).toHaveLength(5);
    // spark1 has reported, so "Connect your nodes" is already done.
    expect(within(p).getByRole('link', { name: /Connect your nodes\s*\(done\)/ })).toBeInTheDocument();
    expect(within(p).getByRole('img', { name: '1 of 5 done' })).toBeInTheDocument();
    await waitFor(() => { expect(fetch).toHaveBeenCalledWith('/api/v1/notify/channels', expect.anything()); });
  });

  it('is one line with the next step once the person has opened something', () => {
    show({ ...first, seen: ['prometheus'] });
    const s = strip();
    expect(s).toHaveAccessibleName('Getting started, 2 of 5 done');
    expect(within(s).getByRole('link', { name: /Next\s*Alerts on your phone/ })).toHaveAttribute('href', '/alerts#notifications');
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('is gone once finished, with no entry in the sidebar and no chip', () => {
    show({ ...first, finished: now });
    expect(screen.queryByText('Getting started', { selector: 'h2' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Get started/ })).toBeNull();
    expect(document.querySelector('.guide-chip, .guide-gone')).toBeNull();
  });

  it('is gone for a console that does not send onboarding (before 0.3.0), and asks it for nothing', () => {
    show(undefined);
    expect(screen.queryByText(/Getting started/)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('names the node to start with when one cannot be reached', () => {
    show(first, { nodes: [node('spark1', { status: 'offline', first_seen: null, last_sample_ts: null })] });
    expect(within(panel()).getByText('It starts with spark1. The rest opens the real pages, in any order.')).toBeInTheDocument();
    expect(within(panel()).getByRole('link', { name: /Connect your nodes/ })).toHaveAttribute('href', '/node/spark1');
  });

  it('tags a row with what the cluster reports', async () => {
    show(first);
    act(() => {
      liveStore.pushSample({ ...(sampleJson as unknown as Sample), node_id: 'spark1', ts: now });
      liveStore.flush();
    });
    const servers = (sampleJson as unknown as Sample).llm?.length ?? 0;
    expect(servers).toBeGreaterThan(0);
    expect(await within(panel()).findByText(`${servers} found`)).toBeInTheDocument();
    expect(within(panel()).getByRole('link', { name: /Model servers\s*\(done\)/ })).toBeInTheDocument();
  });
});

describe('what the person does is kept by the console', () => {
  it('opening a row tells the console which, and goes to the real page', async () => {
    const loc = show(first);
    await userEvent.click(within(panel()).getByRole('link', { name: /Prometheus export/ }));
    expect(sent).toEqual([{ seen: ['prometheus'] }]);
    expect(loc.history.at(-1)).toBe('/settings#prometheus');
    // Back on the overview it is one line, and the count went up.
    expect(await screen.findByRole('region', { name: 'Getting started, 2 of 5 done' })).toBeInTheDocument();
  });

  it('Collapse and Show all are this browser’s choice and send nothing', async () => {
    show(first);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Collapse' }));
    expect(strip()).toBeInTheDocument();
    expect(usePrefs.getState().guideOpen).toBe(false);
    await userEvent.click(within(strip()).getByRole('button', { name: 'Show all' }));
    expect(panel()).toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('dismissing finishes it for good, says where it went, and can be undone on the spot', async () => {
    show(first);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Dismiss getting started' }));
    expect(sent).toEqual([{ finished: true }]);
    expect(screen.getByRole('status')).toHaveTextContent('Getting started is put away. It stays in Settings and in Search (Ctrl K).');
    expect(screen.queryByRole('link', { name: /Get started/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Bring it back' }));
    expect(sent).toEqual([{ finished: true }, { finished: false }]);
    expect(await screen.findByRole('region', { name: 'Getting started' })).toBeInTheDocument();
  });

  it('finishes itself when every row is done, with one quiet line', async () => {
    consoleWith({ channels: 1, runs: 1 });
    show({ ...first, seen: ['model-servers', 'prometheus'] });
    await waitFor(() => { expect(sent).toEqual([{ finished: true }]); });
    expect(screen.getByRole('status')).toHaveTextContent('That is all of it. Getting started is put away. It stays in Settings and in Search (Ctrl K).');
    expect(screen.queryByRole('button', { name: 'Bring it back' })).toBeNull();
  });

  it('does not finish itself before the console has answered what is done', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    show({ ...first, seen: ['model-servers', 'prometheus', 'notifications', 'benchmarks'] });
    await act(() => Promise.resolve());
    expect(strip()).toBeInTheDocument();
  });

  it('Settings opens a finished guide again and goes to the overview', async () => {
    const loc = show({ ...first, finished: now, seen: ['prometheus'] }, { path: '/settings' });
    await userEvent.click(screen.getByRole('button', { name: 'Open getting started' }));
    expect(sent).toEqual([{ finished: false }]);
    expect(loc.history.at(-1)).toBe('/');
    // Asked for by name: every row, not the one-line strip.
    await waitFor(() => { expect(screen.getByRole('region', { name: 'Getting started' })).toHaveFocus(); });
  });
});

describe('the sidebar entry and the phone chip', () => {
  it('show a plain count while the guide is unfinished and bring it into view', async () => {
    const loc = show({ ...first, seen: ['prometheus'] }, { path: '/alerts' });
    const entry = screen.getByRole('link', { name: /Get started/ });
    expect(entry).toHaveTextContent('Get started2 of 5 done');
    expect(screen.getByRole('button', { name: /Getting started\s*2 of 5/ })).toBeInTheDocument();
    await userEvent.click(entry);
    expect(loc.history.at(-1)).toBe('/');
    await waitFor(() => { expect(screen.getByRole('region', { name: 'Getting started' })).toHaveFocus(); });
    expect(sent).toEqual([]);
  });

  it('going to a guide that is already shown in full leaves this browser’s preference alone', async () => {
    show(first);
    await userEvent.click(screen.getByRole('button', { name: /Getting started\s*1 of 5/ }));
    await waitFor(() => { expect(panel()).toHaveFocus(); });
    expect(usePrefs.getState().guideOpen).toBeNull();
    // So it still becomes one line once the person has opened something.
    await userEvent.click(within(panel()).getByRole('link', { name: /Prometheus export/ }));
    expect(await screen.findByRole('region', { name: 'Getting started, 2 of 5 done' })).toBeInTheDocument();
  });
});

describe('adding a row is one object in the table', () => {
  const LATER: readonly GuideItem[] = [
    { id: 'fit', group: 'try', title: 'Will it fit?', blurb: 'See if a Hugging Face model fits a node before you download it.', icon: Ruler, since: '0.3.0', to: () => '/fit' },
    { id: 'serve-recipe', group: 'new', title: 'Serve a recipe', blurb: 'Start a tuned model server on a node with one click.', icon: Play, since: '0.3.0', to: () => '/recipes' },
    { id: 'recommendations', group: 'new', title: 'Recommendations', blurb: 'Community settings, checked against each of your nodes.', icon: Lightbulb, since: '0.3.0', to: () => '/recommendations' },
  ];

  it('draws eight rows in four groups, counts them, and marks one seen like any other', async () => {
    const loc = show(first, { items: [...GUIDE_ITEMS, ...LATER] });
    const p = panel();
    expect(within(p).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Set up', 'Already on', 'Try it', 'New in 0.3.0']);
    expect(within(p).getAllByRole('link')).toHaveLength(8);
    expect(within(p).getByText('Eight things Sparkline does. Each one opens the real page, in any order.')).toBeInTheDocument();
    expect(within(p).getByRole('img', { name: '1 of 8 done' })).toBeInTheDocument();
    await userEvent.click(within(p).getByRole('link', { name: /Serve a recipe/ }));
    expect(sent).toEqual([{ seen: ['serve-recipe'] }]);
    expect(loc.history.at(-1)).toBe('/recipes');
    expect(await screen.findByRole('region', { name: 'Getting started, 2 of 8 done' })).toBeInTheDocument();
  });
});
