// The sign-in link the console installer prints: http://<console>/login#token=<console token>. A browser never
// sends a fragment, so the token is in no query string and reaches no server log. The app takes it out of the
// address bar and out of this tab's history entry before anything else runs, and the sign-in page exchanges it for
// the session cookie. The browser may already have recorded the link it was given as a visited address, token
// included, so the link is as secret as the token.

let pending: string | null = null;

/** Call once at startup. Removes `#token=…` from the address and keeps the token for the sign-in page. */
export function captureSignInLink(loc: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location, hist: Pick<History, 'replaceState' | 'state'> = window.history): void {
  const found = /^#(?:[^#]*&)?token=([^&]*)/.exec(loc.hash)?.[1];
  if (found === undefined) return;
  hist.replaceState(hist.state, '', loc.pathname + loc.search);
  if (!found) return;
  try {
    pending = decodeURIComponent(found);
  } catch {
    pending = found;
  }
}

const listeners = new Set<() => void>();

/** Call once at startup, after captureSignInLink. A link opened in a tab that already shows this app changes only
 *  the fragment, so nothing reloads: the token is taken out of the address just the same. */
export function watchSignInLink(): void {
  window.addEventListener('hashchange', () => {
    captureSignInLink();
    if (pending !== null) for (const tell of listeners) tell();
  });
}

export function onSignInLink(tell: () => void): () => void {
  listeners.add(tell);
  return () => { listeners.delete(tell); };
}

export const hasSignInToken = () => pending !== null;

export function takeSignInToken(): string | null {
  const token = pending;
  pending = null;
  return token;
}
