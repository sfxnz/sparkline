// The getting-started guide, as data. One row per thing Sparkline can do, each a link into the real feature.
//
// To add a feature to the guide, add one object to GUIDE_ITEMS and nothing else: the panel, the one-line strip, the
// sidebar count and the phone chip all draw from this table. A group with no rows is not drawn.
//
// One rule says what is done, for every row: the person has opened it, or the cluster's own state shows it (a
// channel exists, a server was found, a run exists). So a row never stays unticked after the person has been to its
// page, and it is ticked on arrival where the cluster already has the thing. The one exception is marked `stateOnly`.
import { Bell, ChartLine, Gauge, Layers, Server, type LucideIcon } from 'lucide-react';
import { paths } from '../../app/routes';
import { isNewNode, needsSetup } from '../../lib/onboarding';
import type { NodeState } from '../../lib/types';

/** What the rows are derived from. Every field is something the console or a node reported: nothing here is stored
 *  by the guide except `seen` (Onboarding.seen on the console). */
export interface GuideContext {
  /** The cluster's nodes, as they are now. */
  nodes: readonly Pick<NodeState, 'node_id' | 'status' | 'first_seen'>[];
  /** Model servers the agents found: the node and the name the node's card gives it (its model, or its port). */
  servers: readonly { node: string; name: string }[];
  /** Notification channels configured on the console. null: not known yet. */
  notifyChannels: number | null;
  /** Benchmark runs stored on the console. null: not known yet. */
  benchRuns: number | null;
  /** Ids of the rows the person has opened. */
  seen: ReadonlySet<string>;
}

/** What a row asks of the person. Drawn in this order. */
export const GUIDE_GROUPS = [
  { id: 'setup', label: 'Set up' },
  { id: 'on', label: 'Already on' },
  { id: 'try', label: 'Try it' },
  /** Features of the newest release; the heading names it from the rows' `since`. */
  { id: 'new', label: 'New' },
] as const;
export type GuideGroup = (typeof GUIDE_GROUPS)[number]['id'];

export interface GuideItem {
  /** Stable, kebab-case. Stored in Onboarding.seen when the person opens the row. */
  id: string;
  group: GuideGroup;
  title: string;
  /** One line. A function when the cluster's own state says it better ("vLLM on spark1"). */
  blurb: string | ((ctx: GuideContext) => string);
  icon: LucideIcon;
  /** A real route. null: there is nothing to open, and the row is drawn as a line, not as a link. */
  to: (ctx: GuideContext) => string | null;
  /** What the cluster's own state shows. The row is done when this says so, or once the person has opened it. */
  done?: (ctx: GuideContext) => boolean;
  /** Done only when `done` says so: the row asks for something to happen (every node answers), and looking at its
   *  page does not make it so. */
  stateOnly?: boolean;
  /** A short fact from the cluster, shown beside the title ("1 found"). */
  tag?: (ctx: GuideContext) => string | null;
  /** The release that added the feature. Rows in the `new` group are headed "New in <since>". */
  since: string;
}

const names = (ids: readonly string[]) => (ids.length <= 1 ? (ids[0] ?? '') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1) ?? ''}`);
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

export const GUIDE_ITEMS: readonly GuideItem[] = [
  {
    id: 'connect-nodes',
    group: 'setup',
    title: 'Connect your nodes',
    icon: Server,
    since: '0.1.0',
    stateOnly: true,
    done: ({ nodes }) => nodes.length > 0 && !nodes.some(isNewNode),
    tag: ({ nodes }) => {
      const live = nodes.filter((n) => !isNewNode(n)).length;
      return nodes.length > 1 && live < nodes.length ? `${String(live)} of ${String(nodes.length)}` : null;
    },
    blurb: ({ nodes }) => {
      const waiting = nodes.filter(isNewNode).map((n) => n.node_id);
      if (!waiting.length) return nodes.length === 1 ? `${nodes[0]?.node_id ?? 'Your node'} is live. More nodes go in \`console.toml\`.` : `All ${String(nodes.length)} nodes are live.`;
      const stuck = nodes.filter(needsSetup).map((n) => n.node_id);
      if (!stuck.length) return `Waiting for the first reading from ${names(waiting)}.`;
      return `Waiting for ${names(stuck)}. ${stuck.length === 1 ? 'Its card says' : 'Their cards say'} what to do.`;
    },
    // The node that needs something. Once every node has answered there is none, and the nodes are on the page the
    // guide is on.
    to: ({ nodes }) => {
      const first = nodes.find(needsSetup) ?? nodes.find(isNewNode);
      return first ? paths.node(first.node_id) : null;
    },
  },
  {
    id: 'notifications',
    group: 'setup',
    title: 'Alerts on your phone',
    icon: Bell,
    since: '0.2.0',
    done: ({ notifyChannels }) => (notifyChannels ?? 0) > 0,
    tag: ({ notifyChannels }) => (notifyChannels ? plural(notifyChannels, 'channel') : null),
    blurb: 'ntfy, Discord, Slack or a webhook when a node overheats or drops off.',
    to: () => `${paths.alerts}#notifications`,
  },
  {
    id: 'model-servers',
    group: 'on',
    title: 'Model servers',
    icon: Layers,
    since: '0.2.0',
    done: ({ servers }) => servers.length > 0,
    tag: ({ servers }) => (servers.length ? `${String(servers.length)} found` : null),
    blurb: ({ servers }) => {
      const [first] = servers;
      if (!first) return 'vLLM, llama.cpp and others are found on each node with no setup.';
      const more = servers.length - 1;
      return `${first.name} on ${first.node}${more ? ` and ${String(more)} more` : ''}. Requests and speed are on the node’s page.`;
    },
    to: ({ servers, nodes }) => {
      const node = servers[0]?.node ?? nodes.find((n) => !isNewNode(n))?.node_id ?? nodes[0]?.node_id;
      return node ? paths.node(node) : paths.overview;
    },
  },
  {
    id: 'prometheus',
    group: 'on',
    title: 'Prometheus export',
    icon: ChartLine,
    since: '0.2.0',
    blurb: 'Every reading is already at `/metrics`. Point Prometheus or Grafana at it.',
    to: () => `${paths.settings}#prometheus`,
  },
  {
    id: 'benchmarks',
    group: 'try',
    title: 'Benchmarks',
    icon: Gauge,
    since: '0.1.0',
    done: ({ benchRuns }) => (benchRuns ?? 0) > 0,
    blurb: 'Measure tokens per second on a node and compare runs side by side.',
    to: () => paths.benchmarks,
  },
];

export interface GuideRow {
  item: GuideItem;
  done: boolean;
  blurb: string;
  tag: string | null;
  to: string | null;
}

/** A row as it is drawn, from the table and the cluster's state. */
export function guideRow(item: GuideItem, ctx: GuideContext): GuideRow {
  return {
    item,
    done: (item.done?.(ctx) ?? false) || (!item.stateOnly && ctx.seen.has(item.id)),
    blurb: typeof item.blurb === 'function' ? item.blurb(ctx) : item.blurb,
    tag: item.tag?.(ctx) ?? null,
    to: item.to(ctx),
  };
}

export interface GuideSection {
  id: GuideGroup;
  label: string;
  rows: GuideRow[];
}

export interface Guide {
  /** Groups that have rows, in GUIDE_GROUPS order. */
  sections: GuideSection[];
  rows: GuideRow[];
  done: number;
  total: number;
  /** The first row not done, in the order drawn. null: everything is done. */
  next: GuideRow | null;
}

export function buildGuide(ctx: GuideContext, items: readonly GuideItem[] = GUIDE_ITEMS): Guide {
  const sections = GUIDE_GROUPS.map((g) => {
    const mine = items.filter((i) => i.group === g.id);
    // "New in 0.3.0": the newest release among the rows, so the heading never needs editing by hand.
    const newest = mine.map((i) => i.since).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    return { id: g.id, label: g.id === 'new' && newest ? `New in ${newest}` : g.label, rows: mine.map((i) => guideRow(i, ctx)) };
  }).filter((s) => s.rows.length > 0);
  const rows = sections.flatMap((s) => s.rows);
  return { sections, rows, done: rows.filter((r) => r.done).length, total: rows.length, next: rows.find((r) => !r.done) ?? null };
}
