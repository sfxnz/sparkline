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

/** True while a link token waits to be used (the sign-in page starts in its "Signing in…" state). */
export const hasSignInToken = () => pending !== null;

/** The link token, once. */
export function takeSignInToken(): string | null {
  const token = pending;
  pending = null;
  return token;
}
