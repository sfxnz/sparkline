import { checkAuth } from './session';

const reply = (status: number, body: unknown = {}) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));

describe('checkAuth', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the 200 body of /auth/me: signed out is not an HTTP error', async () => {
    vi.stubGlobal('fetch', reply(200, { authenticated: false, auth_required: true, demo: false }));
    expect(await checkAuth()).toBe('unauthorized');
    vi.stubGlobal('fetch', reply(200, { authenticated: true, auth_required: true, demo: false }));
    expect(await checkAuth()).toBe('ok');
  });

  it('still maps a 401 (older consoles), server errors and network failures', async () => {
    vi.stubGlobal('fetch', reply(401));
    expect(await checkAuth()).toBe('unauthorized');
    vi.stubGlobal('fetch', reply(500, { problem: { message: 'x', cause: '', fix: '' } }));
    expect(await checkAuth()).toBe('server');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await checkAuth()).toBe('unreachable');
  });
});
