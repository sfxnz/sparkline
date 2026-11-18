import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ApiError } from '../lib/api';
import { captureSignInLink, hasSignInToken, takeSignInToken, watchSignInLink } from '../lib/signInLink';
import { useAuthInfo } from '../store/session';
import { Login, loginErrorCopy, TOKEN_COMMAND } from './Login';

const reply = (status: number, body: unknown = {}) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
const sentToken = (fetch: ReturnType<typeof reply>) => (JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as { token: string }).token;

function show(firstRun: boolean) {
  useAuthInfo.setState({ firstRun });
  const loc = memoryLocation({ path: '/login', record: true });
  render(<Router hook={loc.hook}><Login /></Router>);
  return loc;
}

afterEach(() => {
  vi.unstubAllGlobals();
  takeSignInToken();
});

describe('sign-in page', () => {
  it('welcomes the first person to sign in and says where the token is, with a command to copy', () => {
    show(true);
    expect(screen.getByRole('heading', { name: 'Welcome to Sparkline' })).toBeInTheDocument();
    expect(screen.getByText(/This console is new/)).toBeInTheDocument();
    expect(document.querySelector('.cmd__text')).toHaveTextContent(TOKEN_COMMAND);
    expect(document.querySelector('.cmd__text')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
    // The field is described by where the token is, so a screen reader hears it on focus.
    expect(screen.getByLabelText('Console token')).toHaveAccessibleDescription(/The token is on the console host\./);
  });

  it('says where the token is in words that hold however the console was installed', () => {
    show(true);
    const where = screen.getByText('The token is on the console host.').closest('p');
    // With Docker Compose no installer ran and the token may be SPARKLINE_TOKEN; an installer whose output was
    // not a terminal printed neither the token nor a link.
    expect(where).toHaveTextContent(
      'The token is on the console host. It is token in /etc/sparkline/console.toml, unless you set SPARKLINE_TOKEN yourself. '
      + 'Run in a terminal, install.sh prints it too, with a link that signs you in without typing. This prints the one in the file:',
    );
    expect(where).not.toHaveTextContent(/printed it|its last lines|print it again/);
  });

  it('is the plain sign-in for a console someone has signed in to, with the same help one click away', async () => {
    const user = userEvent.setup();
    show(false);
    expect(screen.getByRole('heading', { name: 'Sign in to Sparkline' })).toBeInTheDocument();
    expect(screen.queryByText(/This console is new/)).not.toBeInTheDocument();
    const help = screen.getByText('Where is the token?');
    expect(help.closest('details')).not.toHaveAttribute('open');
    await user.click(help);
    expect(help.closest('details')).toHaveAttribute('open');
    expect(document.querySelector('.cmd__text')).toHaveTextContent(TOKEN_COMMAND);
  });

  it('signs in with a typed token and goes to the overview', async () => {
    const user = userEvent.setup();
    const fetch = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    const loc = show(true);
    await user.type(screen.getByLabelText('Console token'), '  the-console-token  ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => { expect(loc.history).toContain('/'); });
    expect(sentToken(fetch)).toBe('the-console-token');
  });
});

describe('a wrong token', () => {
  it('puts focus back in the token field, whether Sign in was clicked or Enter was pressed', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', reply(401, { problem: { message: 'Wrong token', cause: '', fix: '' } }));
    show(false);
    const token = screen.getByLabelText('Console token');
    await user.type(token, 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That token wasn’t accepted.')).toBeInTheDocument();
    expect(token).toHaveFocus();
    await user.type(token, 'x{Enter}');
    expect(await screen.findByText('That token wasn’t accepted.')).toBeInTheDocument();
    expect(token).toHaveFocus();
  });
});

describe('sign-in link', () => {
  const address = (hash: string) => {
    const state = { url: `/login${hash}` };
    const loc = { hash, pathname: '/login', search: '' };
    const hist = { state: null, replaceState: (_s: unknown, _t: string, url: string) => { state.url = url; } };
    return { loc, hist, state };
  };

  it('takes the token out of the address bar and keeps it for one use', () => {
    const { loc, hist, state } = address('#token=abc%2B123_-x');
    captureSignInLink(loc, hist);
    expect(state.url).toBe('/login');
    expect(hasSignInToken()).toBe(true);
    expect(takeSignInToken()).toBe('abc+123_-x');
    expect(takeSignInToken()).toBeNull();
  });

  it('leaves an address without a token alone', () => {
    const { loc, hist, state } = address('#getting-started');
    captureSignInLink(loc, hist);
    expect(state.url).toBe('/login#getting-started');
    expect(hasSignInToken()).toBe(false);
  });

  it('signs in with the link token, with nothing to type', async () => {
    const fetch = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    const { loc, hist } = address('#token=link-token-0123456789');
    captureSignInLink(loc, hist);
    const at = show(true);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    await waitFor(() => { expect(at.history).toContain('/'); });
    expect(sentToken(fetch)).toBe('link-token-0123456789');
  });

  it('keeps one title while a link signs in, whatever /auth/me says meanwhile', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const { loc, hist } = address('#token=not-the-token');
    captureSignInLink(loc, hist);
    show(false);
    const title = screen.getByRole('heading', { level: 1 }).textContent;
    act(() => { useAuthInfo.setState({ firstRun: true }); }); // /auth/me answers: nobody has signed in here yet
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
    expect(screen.getByText('Signing in with your link.')).toBeInTheDocument();
    expect(screen.queryByText(/This console is new/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    // The link's token is refused: now it is the first-run form, with the error, under the title it had.
    act(() => { answer(new Response('{}', { status: 401 })); });
    expect(await screen.findByText('That token wasn’t accepted.')).toBeInTheDocument();
    expect(screen.getByText(/This console is new/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(title);
  });

  it('keeps the title, and the help, of a first-run page when a link is opened in its tab, right or wrong', async () => {
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    watchSignInLink();
    show(true);
    const title = () => screen.getByRole('heading', { level: 1 });
    expect(title()).toHaveTextContent('Welcome to Sparkline');
    window.history.replaceState(null, '', '/login#token=not-the-token');
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByText('Signing in with your link.')).toBeInTheDocument();
    expect(title()).toHaveTextContent('Welcome to Sparkline');
    expect(document.querySelector('.cmd__text')).toHaveTextContent(TOKEN_COMMAND);
    act(() => { answer(new Response('{}', { status: 401 })); });
    expect(await screen.findByText('That token wasn’t accepted.')).toBeInTheDocument();
    expect(title()).toHaveTextContent('Welcome to Sparkline');
  });

  it('signs in when the link is opened in a tab that already shows the sign-in page', async () => {
    const fetch = reply(200, { ok: true });
    vi.stubGlobal('fetch', fetch);
    watchSignInLink();
    const at = show(true);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    window.history.replaceState(null, '', '/login#token=pasted-link-token');
    act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => { expect(at.history).toContain('/'); });
    expect(sentToken(fetch)).toBe('pasted-link-token');
    expect(window.location.hash).toBe('');
  });

  it('falls back to the form with the usual error when the link token is wrong', async () => {
    vi.stubGlobal('fetch', reply(401, { problem: { message: 'Wrong token', cause: '', fix: '' } }));
    const { loc, hist } = address('#token=not-the-token');
    captureSignInLink(loc, hist);
    const at = show(false);
    expect(await screen.findByText('That token wasn’t accepted.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByLabelText('Console token')).toHaveValue('');
    expect(screen.getByLabelText('Console token')).toHaveFocus();
    expect(at.history).not.toContain('/');
  });
});

describe('sign-in errors', () => {
  it('says what the console said when it refuses the request, never the JSON it came in', () => {
    const body = JSON.stringify({ problem: { message: 'Too many sign-in attempts', cause: '10 attempts per minute allowed', fix: 'Wait a minute and try again' } });
    const copy = loginErrorCopy(new ApiError('client', 429, body.slice(0, 300), body));
    expect(copy).toEqual({ title: 'Too many sign-in attempts.', detail: '10 attempts per minute allowed. Wait a minute and try again.' });
    expect(`${copy.title} ${copy.detail}`).not.toContain('{');
  });

  it('still says something useful for a refusal with no problem body', () => {
    const copy = loginErrorCopy(new ApiError('client', 400, 'Bad Request', 'Bad Request'));
    expect(copy.title).toBe('Couldn’t sign in.');
    expect(copy.detail).toContain('HTTP 400');
  });
});
