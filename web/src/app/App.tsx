import { LazyMotion, MotionConfig } from 'motion/react';
import { Suspense, useEffect } from 'react';
import { Route, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '../design/components/ErrorBoundary';
import { LiveAnnouncer } from '../design/components/LiveAnnouncer';
import { createShortcutHandler } from '../lib/shortcuts';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { usePrefs, watchSystemTheme } from '../store/prefs';
import { startSession } from '../store/session';
import { useUi } from '../store/ui';
import { CommandPalette } from './CommandPalette';
import { Login, Wall, documentTitle, paths } from './routes';
import { Shell } from './Shell';
import { ShortcutsHelp } from './ShortcutsHelp';

/** Animation features are a separate chunk: the first paint does not wait for them (m.* render static until loaded). */
const loadMotionFeatures = () => import('./motionFeatures').then((mod) => mod.default);

function useGlobalShortcuts() {
  const [, navigate] = useLocation();
  useEffect(() => {
    const ui = () => useUi.getState();
    const dialogOpen = () => ui().paletteOpen || ui().helpOpen;
    const go = (to: string) => () => { if (!dialogOpen()) navigate(to); };
    const handler = createShortcutHandler([
      { keys: 'mod+k', allowInInputs: true, run: () => { ui().setPalette(!ui().paletteOpen); } },
      { keys: '?', run: () => { ui().setHelp(true); } },
      { keys: 'g o', run: go(paths.overview) },
      { keys: 'g a', run: go(paths.alerts) },
      { keys: 'g b', run: go(paths.benchmarks) },
      { keys: 'g s', run: go(paths.settings) },
      { keys: 'w', run: go(paths.wall) },
      { keys: 't', run: () => { if (!dialogOpen()) usePrefs.getState().cycleTheme(); } },
      ...Array.from({ length: 9 }, (_, i) => ({
        keys: String(i + 1),
        run: () => {
          const id = useCluster.getState().order[i];
          if (id && !dialogOpen()) navigate(paths.node(id));
        },
      })),
    ], { singleKeys: () => usePrefs.getState().singleKeyShortcuts });
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, [navigate]);
}

function useAuthRedirect() {
  const [location, navigate] = useLocation();
  const status = useConnection((s) => s.status);
  useEffect(() => {
    if (status === 'unauthorized' && location !== paths.login) navigate(paths.login, { replace: true });
    if (status === 'live' && location === paths.login) navigate('/', { replace: true });
  }, [status, location, navigate]);
}

function useDocumentTitle() {
  const [location] = useLocation();
  useEffect(() => {
    document.title = documentTitle(location);
  }, [location]);
}

export function App() {
  useEffect(() => {
    startSession();
    return watchSystemTheme();
  }, []);
  useGlobalShortcuts();
  useAuthRedirect();
  useDocumentTitle();

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={loadMotionFeatures} strict>
        <ErrorBoundary what="Sparkline">
          {/* Wall mode and sign-in are their own chunks; the shell has its own Suspense for its pages. */}
          <Suspense fallback={null}>
            <Switch>
              <Route path="/login" component={Login} />
              <Route path="/wall" component={Wall} />
              <Route>
                <Shell />
              </Route>
            </Switch>
          </Suspense>
          <CommandPalette />
          <ShortcutsHelp />
        </ErrorBoundary>
        <LiveAnnouncer />
      </LazyMotion>
    </MotionConfig>
  );
}
