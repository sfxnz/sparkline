// The guide's three shapes follow the console's Onboarding, and everything it stores goes to the console.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { mergeOnboarding } from '../../lib/onboarding';
import type { ClusterState, NodeState, Onboarding, OnboardingPatch, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { useGuideFacts } from '../../store/guide';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { dispatch } from '../../store/session';
import { useUi } from '../../store/ui';
import sampleJson from '../../test/fixtures/sample.json';
import { CommandPalette } from '../../app/CommandPalette';
import { AboutSection } from '../settings/AboutSection';
import { Guide, GuideChip, GuideEntry } from './Guide';
import { GUIDE_ITEMS } from './items';

const now = Date.now() / 1000;
const node = (id: string, p: Partial<NodeState> = {}): NodeState => ({
  node_id: id, url: 'http://192.168.1.11:9750', status: 'online', since: now, last_sample_ts: now, error: null, info: null, next_retry_ts: null, first_seen: now, ...p,
});
const cluster = (onboarding: Onboarding | undefined, nodes: NodeState[] = [node('spark1')]): ClusterState => ({
  nodes, settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 }, demo: false, version: 'test', server_time: now, onboarding,
});
const first: Onboarding = { started: now, finished: null, reopened: false, seen: [] };

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
function show(onboarding: Onboarding | undefined, opts: { nodes?: NodeState[]; path?: string } = {}) {
  useCluster.getState().setHello(cluster(onboarding, opts.nodes));
  const loc = memoryLocation({ path: opts.path ?? '/', record: true });
  render(<Router hook={loc.hook}><GuideChip /><Guide /><GuideEntry collapsed={false} /><AboutSection /><CommandPalette /></Router>);
  return loc;
}
const panel = () => screen.getByRole('region', { name: 'Getting started' });
// jsdom has no layout, so Testing Library joins the text of sibling spans without the space a browser reads
// between them; the names below allow for it, and e2e/onboarding.spec.ts reads the real ones.
const strip = () => screen.getByRole('region', { name: /^Getting started, \d+ of \d+ done$/ });
// The table decides how many rows there are and which: a row added to GUIDE_ITEMS changes no test here.
const ROWS = GUIDE_ITEMS.length;
const EVERY_ROW = GUIDE_ITEMS.map((i) => i.id);

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});
beforeEach(() => {
  useConnection.setState({ status: 'live', everLive: true });
  useGuideFacts.setState({ notifyChannels: null, benchRuns: null });
  useUi.setState({ guideWanted: false, guideLeft: null, paletteOpen: false });
  usePrefs.setState({ guideOpen: null });
  liveStore.removeNode('spark1');
  consoleWith();
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('the guide follows the console', () => {
  it('shows every row, grouped, on a first visit', async () => {
    show(first);
    const p = panel();
    expect(within(p).getByText(/^\w+ things Sparkline does\. Each one opens the real page, in any order\.$/)).toBeInTheDocument();
    expect(within(p).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Set up', 'Already on', 'Try it']);
    expect(within(p).getAllByRole('listitem')).toHaveLength(ROWS);
    // spark1 has reported, so "Connect your nodes" is already done. Its nodes are on this page: it is not a link.
    expect(within(p).getByText('Connect your nodes').closest('.guide-tile')).toHaveTextContent(/Connect your nodes\s*\(done\)/);
    expect(within(p).queryByRole('link', { name: /Connect your nodes/ })).toBeNull();
    expect(within(p).getAllByRole('link')).toHaveLength(ROWS - 1);
    expect(within(p).getByRole('img', { name: `1 of ${ROWS} done` })).toBeInTheDocument();
    await waitFor(() => { expect(fetch).toHaveBeenCalledWith('/api/v1/notify/channels', expect.anything()); });
  });

  it('is one line with the next step once the person has opened something', () => {
    show({ ...first, seen: ['prometheus'] });
    const s = strip();
    expect(s).toHaveAccessibleName(`Getting started, 2 of ${ROWS} done`);
    expect(within(s).getByRole('link', { name: /Next\s*Alerts on your phone/ })).toHaveAttribute('href', '/alerts#notifications');
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('ticks a row the person has opened and moves "Next" on, whatever the cluster has', () => {
    // No channel and no benchmark run on this console: the Alerts and Benchmarks pages were opened, and that counts.
    show({ ...first, seen: ['notifications', 'benchmarks'] });
    const s = strip();
    expect(s).toHaveAccessibleName(`Getting started, 3 of ${ROWS} done`);
    expect(within(s).getByRole('link', { name: /Next\s*Model servers/ })).toBeInTheDocument();
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
    expect(await screen.findByRole('region', { name: `Getting started, 2 of ${ROWS} done` })).toBeInTheDocument();
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

  it('hands the keyboard from a control that goes away to the one that takes its place, never to <body>', async () => {
    const user = userEvent.setup();
    show(first);
    const collapse = () => within(panel()).getByRole('button', { name: 'Collapse' });
    collapse().focus();
    await user.keyboard('{Enter}');
    expect(within(strip()).getByRole('button', { name: 'Show all' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(collapse()).toHaveFocus();

    within(panel()).getByRole('button', { name: 'Dismiss getting started' }).focus();
    await user.keyboard(' ');
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Bring it back' })).toHaveFocus(); });
    await user.keyboard('{Enter}');
    await waitFor(() => { expect(collapse()).toHaveFocus(); });
    // It stays there: the guide coming into view a frame later does not take focus from a control inside it.
    await act(() => new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); }));
    expect(useUi.getState().guideWanted).toBe(false);
    expect(collapse()).toHaveFocus();
  });

  it('finishes itself when every row is done, with one quiet line', async () => {
    // The console has a channel and a run. Every other row was opened.
    consoleWith({ channels: 1, runs: 1 });
    show({ ...first, seen: EVERY_ROW.filter((id) => id !== 'notifications' && id !== 'benchmarks') });
    await waitFor(() => { expect(sent).toEqual([{ finished: true }]); });
    expect(screen.getByRole('status')).toHaveTextContent('That is all of it. Getting started is put away. It stays in Settings and in Search (Ctrl K).');
    expect(screen.queryByRole('button', { name: 'Bring it back' })).toBeNull();
  });

  it('finishes itself once every page has been opened, on a console with no channel and no run', async () => {
    show({ ...first, seen: EVERY_ROW });
    await waitFor(() => { expect(sent).toEqual([{ finished: true }]); });
    expect(screen.getByRole('status')).toHaveTextContent('That is all of it. Getting started is put away.');
  });

  it('does not finish itself before the console has answered what is done', async () => {
    const theConsole = vi.mocked(fetch).getMockImplementation();
    let answer = () => {};
    const asked = new Promise<void>((done) => { answer = done; });
    vi.mocked(fetch).mockImplementation((...args) => asked.then(() => theConsole?.(...args) ?? Response.error()));
    show({ ...first, seen: EVERY_ROW });
    await act(() => Promise.resolve());
    expect(strip()).toBeInTheDocument();
    // The request for the two counts is shared by every test in this file: it ends with this one.
    answer();
    await waitFor(() => { expect(sent).toEqual([{ finished: true }]); });
    await act(() => new Promise<void>((done) => { setTimeout(done, 0); }));
  });

  it.each(['Settings', 'Search'])('a guide that finished itself comes back from %s and stays, every row ticked, until it is dismissed', async (from) => {
    const user = userEvent.setup();
    const loc = show({ ...first, seen: EVERY_ROW }, { path: '/settings' });
    await waitFor(() => { expect(sent).toEqual([{ finished: true }]); });
    await waitFor(() => { expect(useCluster.getState().onboarding?.finished).not.toBeNull(); });

    if (from === 'Settings') await user.click(screen.getByRole('button', { name: 'Open getting started' }));
    else {
      act(() => { useUi.getState().setPalette(true); });
      await user.type(screen.getByRole('combobox', { name: /Search views/ }), 'getting started');
      await user.keyboard('{Enter}');
    }
    expect(loc.history.at(-1)).toBe('/');
    await waitFor(() => { expect(panel()).toHaveFocus(); });
    await waitFor(() => { expect(useCluster.getState().onboarding).toMatchObject({ finished: null, reopened: true }); });
    // Long enough for an effect to have put it away again.
    await act(() => new Promise<void>((done) => { setTimeout(done, 50); }));
    expect(sent).toEqual([{ finished: true }, { finished: false }]);
    const rows = within(panel()).getAllByRole('listitem');
    expect(rows).toHaveLength(ROWS);
    for (const row of rows) expect(row).toHaveTextContent('(done)');
    expect(within(panel()).getByRole('link', { name: /Prometheus export\s*\(done\)/ })).toHaveAttribute('href', '/settings#prometheus');

    await user.click(within(panel()).getByRole('button', { name: 'Dismiss getting started' }));
    expect(sent.at(-1)).toEqual({ finished: true });
    await waitFor(() => { expect(useCluster.getState().onboarding).toMatchObject({ reopened: false }); });
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('a guide brought back on another device is not put away by this one', async () => {
    show({ ...first, seen: EVERY_ROW, finished: now });
    act(() => { dispatch({ type: 'onboarding', onboarding: { ...first, seen: EVERY_ROW, reopened: true } }); });
    await waitFor(() => { expect(useGuideFacts.getState().benchRuns).not.toBeNull(); });
    await act(() => new Promise<void>((done) => { setTimeout(done, 50); }));
    expect(sent).toEqual([]);
    // It is what the browser that asked shows: every row, ticked. This browser's own Collapse still makes it one line.
    for (const row of within(panel()).getAllByRole('listitem')) expect(row).toHaveTextContent('(done)');
    await userEvent.click(within(panel()).getByRole('button', { name: 'Collapse' }));
    expect(strip()).toHaveAccessibleName(`Getting started, ${ROWS} of ${ROWS} done`);
  });

  it('Settings brings a guide still in progress into view and leaves it to finish itself', async () => {
    const loc = show({ ...first, seen: ['prometheus'] }, { path: '/settings' });
    await userEvent.click(screen.getByRole('button', { name: 'Open getting started' }));
    expect(loc.history.at(-1)).toBe('/');
    await waitFor(() => { expect(panel()).toHaveFocus(); });
    expect(sent).toEqual([]);
    expect(useCluster.getState().onboarding?.reopened).toBe(false);
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
    expect(entry).toHaveTextContent(`Get started2 of ${ROWS} done`);
    expect(screen.getByRole('button', { name: new RegExp(`Getting started\\s*2 of ${ROWS}`) })).toBeInTheDocument();
    await userEvent.click(entry);
    expect(loc.history.at(-1)).toBe('/');
    await waitFor(() => { expect(screen.getByRole('region', { name: 'Getting started' })).toHaveFocus(); });
    expect(sent).toEqual([]);
  });

  it('going to a guide that is already shown in full leaves this browser’s preference alone', async () => {
    show(first);
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`Getting started\\s*1 of ${ROWS}`) }));
    await waitFor(() => { expect(panel()).toHaveFocus(); });
    expect(usePrefs.getState().guideOpen).toBeNull();
    // So it still becomes one line once the person has opened something.
    await userEvent.click(within(panel()).getByRole('link', { name: /Prometheus export/ }));
    expect(await screen.findByRole('region', { name: `Getting started, 2 of ${ROWS} done` })).toBeInTheDocument();
  });
});
