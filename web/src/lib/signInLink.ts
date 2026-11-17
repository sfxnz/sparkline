// The sign-in link the console installer prints: http://<console>/login#token=<console token>. A fragment never
// reaches the server or its logs. The app takes the token out of the address bar before anything else runs, so it
// is not left in the history, a screenshot or a bookmark, and the sign-in page exchanges it for the session cookie.

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

/** Be told when a link token arrives while the page is open. Returns the unsubscribe function. */
export function onSignInLink(tell: () => void): () => void {
  listeners.add(tell);
  return () => { listeners.delete(tell); };
}

/** True while a link token waits to be used (the sign-in page starts in its "Signing in…" state). */
export const hasSignInToken = () => pending !== null;

/** The link token, once. */
export function takeSignInToken(): string | null {
  const token = pending;
  pending = null;
  return token;
}
