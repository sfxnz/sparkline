const FRESH_MS = 10_000;

/** A tab opened before an update still runs the old build, whose lazy chunks the new build no longer has. Vite reports
 *  each failed chunk or CSS load as `vite:preloadError`: reload onto the new build. A page loaded less than FRESH_MS
 *  ago came from the current build (this covers the page right after that reload, so it cannot loop), so its failures
 *  fall through to the error boundaries. */
export function reloadOnStaleBuild(reload = () => { window.location.reload(); }): () => void {
  const onPreloadError = () => {
    if (performance.now() >= FRESH_MS) reload();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  return () => { window.removeEventListener('vite:preloadError', onPreloadError); };
}
