import { Bell, Compass, Gauge, LayoutGrid, Monitor, PanelLeftClose, PanelLeftOpen, Search, Server, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { m } from 'motion/react';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { Button, IconButton } from '../design/components/Button';
import { EmptyState } from '../design/components/EmptyState';
import { ErrorBoundary } from '../design/components/ErrorBoundary';
import { Kbd } from '../design/components/Kbd';
import { SegmentedControl, type Segment } from '../design/components/SegmentedControl';
import { StatusPill } from '../design/components/StatusPill';
import { springs } from '../design/motion';
import type { TimeRange } from '../lib/prefs';
import { isApple } from '../lib/shortcuts';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { useNodeDisplayStatus } from '../store/attention';
import { openAlertCount, useEvents } from '../store/events';
import { usePrefs } from '../store/prefs';
import { useUi } from '../store/ui';
import Alerts from '../views/Alerts';
import Node from '../views/Node';
import Overview from '../views/Overview';
import Settings from '../views/Settings';
import { ChartPanelSkeleton } from '../views/placeholders';
import { ConnectionIndicator } from './ConnectionIndicator';
import { ConnectionProblem } from './ConnectionProblem';
import { Benchmarks, pageTitle, paths } from './routes';
import './Shell.css';

const RANGES: readonly Segment<TimeRange>[] = [
  { value: 'live', label: 'Live', ariaLabel: 'Live' },
  { value: '5m', label: '5m', ariaLabel: 'Last 5 minutes' },
  { value: '1h', label: '1h', ariaLabel: 'Last hour' },
  { value: '24h', label: '24h', ariaLabel: 'Last 24 hours' },
  { value: '7d', label: '7d', ariaLabel: 'Last 7 days' },
];

export function Shell() {
  const [location] = useLocation();
  const conn = useConnection();
  // Below ~40rem (a phone, or 400% zoom on a laptop) the sidebar is icons only, whatever the preference, so the page
  // keeps a usable width. In rem, so it also applies when the user's font size is large.
  const narrow = useMediaQuery('(max-width: 40rem)');
  const collapsed = usePrefs((s) => s.sidebarCollapsed) || narrow;
  const showProblem = !conn.everLive && (conn.status === 'reconnecting' || conn.status === 'offline');
  useFocusAfterNavigation(location);

  return (
    <div className={`shell${collapsed ? ' shell--collapsed' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <Sidebar collapsed={collapsed} canExpand={!narrow} location={location} />
      <div className="shell__main">
        <Toolbar location={location} />
        <main id="main" className="shell__content" tabIndex={-1}>
          {showProblem ? (
            <ConnectionProblem state={conn} />
          ) : (
            <ErrorBoundary what={pageTitle(location)} resetKey={location}>
              <m.div
                key={location.split('/').slice(0, 3).join('/')}
                className="shell__page"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={springs.gentle}
              >
                <Suspense fallback={<ChartPanelSkeleton title="Loading…" />}>
                  <Switch>
                    <Route path="/" component={Overview} />
                    <Route path="/node/:id/:tab?" component={Node} />
                    <Route path="/alerts" component={Alerts} />
                    <Route path="/benchmarks" component={Benchmarks} />
                    <Route path="/benchmarks/runs/:id" component={Benchmarks} />
                    <Route path="/benchmarks/compare" component={Benchmarks} />
                    <Route path="/settings" component={Settings} />
                    <Route>
                      <EmptyState icon={Compass} title="Nothing here" action={<Link href="/" className="btn btn--secondary btn--md">Go to Overview</Link>}>
                        This address doesn’t match a page in Sparkline.
                      </EmptyState>
                    </Route>
                  </Switch>
                </Suspense>
              </m.div>
            </ErrorBoundary>
          )}
        </main>
      </div>
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const on = () => { setMatches(mq.matches); };
    on();
    mq.addEventListener('change', on);
    return () => { mq.removeEventListener('change', on); };
  }, [query]);
  return matches;
}

/**
 * After a route change that left focus nowhere (the command palette or a keyboard shortcut navigated, and the element
 * that had focus is gone), move it to the page's main region, so keyboard and screen-reader users land on the new
 * page instead of the document body. Links that keep focus (sidebar, in-page) are left alone.
 */
function useFocusAfterNavigation(location: string) {
  const first = useRef(true);
  // A new page (same key as the page transition below; node tabs keep their place) starts at the top, not at the
  // scroll position of the page it was opened from.
  const page = location.split('/').slice(0, 3).join('/');
  useEffect(() => {
    if (!first.current) window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const raf = requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      document.getElementById('main')?.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(raf); };
  }, [location]);
}

function NavItem({ href, icon: Icon, label, active, collapsed, trailing }: { href: string; icon: LucideIcon; label: string; active: boolean; collapsed: boolean; trailing?: ReactNode }) {
  return (
    <li>
      <Link href={href} className={`nav__item${active ? ' is-active' : ''}`} aria-current={active ? 'page' : undefined} title={collapsed ? label : undefined}>
        <Icon className="nav__icon" aria-hidden="true" strokeWidth={1.9} />
        <span className="nav__label">{label}</span>
        {trailing}
      </Link>
    </li>
  );
}

function NodeNavItem({ id, index, active, collapsed }: { id: string; index: number; active: boolean; collapsed: boolean }) {
  const st = useNodeDisplayStatus(id);
  return (
    <NavItem
      href={paths.node(id)}
      icon={Server}
      label={id}
      active={active}
      collapsed={collapsed}
      trailing={
        <span className="nav__trailing">
          <StatusPill status={st} variant="inline" size="sm" />
          {index < 9 ? <span className="visually-hidden">, shortcut {index + 1}</span> : null}
        </span>
      }
    />
  );
}

function Sidebar({ collapsed, canExpand, location }: { collapsed: boolean; canExpand: boolean; location: string }) {
  const order = useCluster((s) => s.order);
  const alerts = useEvents((s) => openAlertCount(s.events));
  const everLive = useConnection((s) => s.everLive);
  const setPrefs = usePrefs((s) => s.set);
  const [, navigate] = useLocation();

  return (
    <aside className="sidebar material-thin" aria-label="Primary">
      <div className="sidebar__brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="28" height="28"><rect width="32" height="32" rx="9" fill="var(--accent-fill)" /><path d="M7 19.5h4l2.5-7 4 12 3-9 1.5 4H25" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <span className="sidebar__name">Sparkline</span>
      </div>

      <nav className="sidebar__nav" aria-label="Main">
        <ul className="nav">
          <NavItem href="/" icon={LayoutGrid} label="Overview" active={location === '/'} collapsed={collapsed} />
        </ul>

        <div className="nav__section">
          <h2 className="nav__heading">Nodes</h2>
          {order.length ? (
            <ul className="nav">
              {order.map((id, i) => (
                <NodeNavItem key={id} id={id} index={i} active={location.startsWith(`/node/${encodeURIComponent(id)}`)} collapsed={collapsed} />
              ))}
            </ul>
          ) : (
            <p className="nav__empty">{everLive ? 'No nodes configured' : 'Waiting for the console'}</p>
          )}
        </div>

        <div className="nav__section">
          <ul className="nav">
            <NavItem
              href="/alerts"
              icon={Bell}
              label="Alerts"
              active={location.startsWith('/alerts')}
              collapsed={collapsed}
              trailing={
                alerts > 0 ? (
                  <span className="nav__badge num">
                    {alerts}
                    <span className="visually-hidden"> open {alerts === 1 ? 'alert' : 'alerts'}</span>
                  </span>
                ) : null
              }
            />
            <NavItem href="/benchmarks" icon={Gauge} label="Benchmarks" active={location.startsWith('/benchmarks')} collapsed={collapsed} />
            <NavItem href="/settings" icon={SettingsIcon} label="Settings" active={location.startsWith('/settings')} collapsed={collapsed} />
          </ul>
        </div>
      </nav>

      <div className="sidebar__foot">
        <Button variant="ghost" className="sidebar__wall" icon={<Monitor />} onClick={() => { navigate(paths.wall); }} title={collapsed ? 'Wall mode' : undefined} aria-label={collapsed ? 'Wall mode' : undefined}>
          <span className="nav__label">Wall mode</span>
        </Button>
        {canExpand ? (
          <IconButton
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            onClick={() => { setPrefs({ sidebarCollapsed: !collapsed }); }}
          />
        ) : null}
      </div>
    </aside>
  );
}

function Toolbar({ location }: { location: string }) {
  const range = usePrefs((s) => s.timeRange);
  const everLive = useConnection((s) => s.everLive);
  const setPrefs = usePrefs((s) => s.set);
  const openPalette = useUi((s) => s.setPalette);
  const title = pageTitle(location);
  const nodeId = /^\/node\/([^/]+)/.exec(location)?.[1];
  const apple = isApple();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => { setScrolled(window.scrollY > 0); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); };
  }, []);

  return (
    <header className={`toolbar${scrolled ? ' is-scrolled' : ''}`}>
      <div className="toolbar__title">
        {/* A node page shows its name and status in its own header (shared element with the overview card), so the
            toolbar keeps the page heading for assistive tech only instead of repeating it. */}
        <h1 className={nodeId ? 'visually-hidden' : 't-large-title'}>{title}</h1>
      </div>
      <div className="toolbar__controls">
        {/* The range applies to charts: only the screens that have them offer it. */}
        {location === '/' || nodeId ? <SegmentedControl label="Time range" options={RANGES} value={range} onChange={(v) => { setPrefs({ timeRange: v }); }} /> : null}
        {/* Before the first connection the page itself offers Retry; avoid a duplicate here. */}
        <ConnectionIndicator showRetry={everLive} />
        <button type="button" className="toolbar__search" onClick={() => { openPalette(true); }} aria-keyshortcuts={apple ? 'Meta+K' : 'Control+K'}>
          <Search aria-hidden="true" />
          <span>Search</span>
          <span className="toolbar__kbd" aria-hidden="true">
            <Kbd>{apple ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </div>
    </header>
  );
}
