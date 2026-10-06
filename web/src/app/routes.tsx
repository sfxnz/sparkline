import { lazy } from 'react';

export const NODE_TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'gpu', label: 'GPU' },
  { id: 'memory', label: 'Memory' },
  { id: 'cpu', label: 'CPU' },
  { id: 'network', label: 'Network' },
  { id: 'storage', label: 'Storage' },
  { id: 'thermals', label: 'Thermals & Power' },
  { id: 'processes', label: 'Processes' },
] as const;
export type NodeTab = (typeof NODE_TABS)[number]['id'];

export const isNodeTab = (x: string | undefined): x is NodeTab => NODE_TABS.some((t) => t.id === x);

export const paths = {
  overview: '/',
  node: (id: string, tab?: NodeTab) => `/node/${encodeURIComponent(id)}${tab && tab !== 'summary' ? `/${tab}` : ''}`,
  alerts: '/alerts',
  benchmarks: '/benchmarks',
  settings: '/settings',
  wall: '/wall',
  login: '/login',
};

/** The benchmark suite is its own chunk. */
export const Benchmarks = lazy(() => import('../views/Benchmarks'));

/** Large title for the toolbar. */
export function pageTitle(location: string): string {
  if (location === '/') return 'Overview';
  const node = /^\/node\/([^/]+)/.exec(location);
  if (node?.[1]) return decodeURIComponent(node[1]);
  if (location.startsWith('/alerts')) return 'Alerts';
  if (location.startsWith('/benchmarks')) return 'Benchmarks';
  if (location.startsWith('/settings')) return 'Settings';
  return 'Sparkline';
}

/** Browser tab title: "<page> · Sparkline"; node tabs say which tab ("GPU · spark2 · Sparkline"). */
export function documentTitle(location: string): string {
  const page = location === paths.wall ? 'Wall mode' : location === paths.login ? 'Sign in' : pageTitle(location);
  const tab = /^\/node\/[^/]+\/([^/?#]+)/.exec(location)?.[1];
  const tabLabel = NODE_TABS.find((t) => t.id === tab && t.id !== 'summary')?.label;
  if (page === 'Sparkline') return page;
  return tabLabel ? `${tabLabel} · ${page} · Sparkline` : `${page} · Sparkline`;
}
