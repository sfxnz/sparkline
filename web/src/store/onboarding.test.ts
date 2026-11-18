import type { ClusterState, Onboarding } from '../lib/types';
import { useCluster } from './cluster';
import { patchOnboarding } from './onboarding';
import { checkAuth, dispatch, useAuthInfo } from './session';

const row: Onboarding = { started: 100, finished: null, reopened: false, seen: [] };
const cluster = (onboarding?: Onboarding): ClusterState => ({
  nodes: [],
  settings: { energy_rate_per_kwh: 0.28, currency: '£', stale_after_s: 5, offline_after_s: 30, regression_pct: 5 },
  demo: false,
  version: '0.3.0',
  server_time: Date.now() / 1000,
  ...(onboarding ? { onboarding } : {}),
});
const reply = (status: number, body: unknown = {}) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));

describe('onboarding transport', () => {
  beforeEach(() => {
    useCluster.getState().setHello(cluster(row));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('hello carries the state, and a console without it leaves none', () => {
    expect(useCluster.getState().onboarding).toEqual(row);
    useCluster.getState().setHello(cluster());
    expect(useCluster.getState().onboarding).toBeNull();
  });

  it("an onboarding message from another tab replaces this tab's state", () => {
    dispatch({ type: 'onboarding', onboarding: { ...row, seen: ['prometheus'] } });
    expect(useCluster.getState().onboarding?.seen).toEqual(['prometheus']);
  });

  it('a patch shows at once, is sent as a PUT, and ends as what the console answered', async () => {
    const fetch = reply(200, { ...row, seen: ['benchmarks'], finished: null });
    vi.stubGlobal('fetch', fetch);
    const sent = patchOnboarding({ seen: ['benchmarks'] });
    expect(useCluster.getState().onboarding?.seen).toEqual(['benchmarks']); // before the console answers
    await sent;
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/onboarding');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ seen: ['benchmarks'] });
    expect(useCluster.getState().onboarding).toEqual({ ...row, seen: ['benchmarks'] });
  });

  it('a patch the console never received is taken back', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    await patchOnboarding({ finished: true });
    expect(useCluster.getState().onboarding).toEqual(row);
  });

  it('Dismiss then Bring it back, before the console answered: the screen never goes back to "dismissed"', async () => {
    // The console answers each PUT only when the test lets it, and broadcasts each change as it would.
    const answers: ((r: Response) => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { answers.push(resolve); }));
    vi.stubGlobal('fetch', fetch);
    const json = (body: Onboarding) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const shown = () => useCluster.getState().onboarding?.finished;

    const dismissed = patchOnboarding({ finished: true });
    const back = patchOnboarding({ finished: false });
    expect(shown()).toBeNull();
    // One at a time, in order: the second PUT waits for the first answer.
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    dispatch({ type: 'onboarding', onboarding: { ...row, finished: 200 } }); // the broadcast of the first change
    expect(shown()).toBeNull();
    answers[0]?.(json({ ...row, finished: 200 }));
    await dismissed;
    expect(shown()).toBeNull();
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2); });
    answers[1]?.(json(row));
    await back;
    expect(useCluster.getState().onboarding).toEqual(row);
    dispatch({ type: 'onboarding', onboarding: { ...row, seen: ['benchmarks'] } });
    expect(useCluster.getState().onboarding?.seen).toEqual(['benchmarks']);
  });

  it('does nothing against a console with no first-run state', async () => {
    const fetch = reply(200, row);
    vi.stubGlobal('fetch', fetch);
    useCluster.getState().setHello(cluster());
    await patchOnboarding({ finished: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers whether /auth/me says nobody has signed in yet', async () => {
    vi.stubGlobal('fetch', reply(200, { authenticated: false, auth_required: true, demo: false, first_run: true }));
    await checkAuth();
    expect(useAuthInfo.getState().firstRun).toBe(true);
    vi.stubGlobal('fetch', reply(200, { authenticated: true, auth_required: true, demo: false }));
    await checkAuth();
    expect(useAuthInfo.getState().firstRun).toBe(false);
  });
});
