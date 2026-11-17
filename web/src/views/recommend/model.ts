// What the Recommendations page derives from the console's answer: each setting's rows (one per node), which
// settings lead the page, what a click may do, and the words of the confirmation.
import type { NodeRecState, Problem, Recommendation, RecommendationsView } from '../../lib/types';

export type Verb = 'apply' | 'undo';

/** One node's answer for one setting: what its agent read (`item`), or why there is no answer (`problem`). */
export type NodeRow =
  | { node: string; item: NodeRecState; /** Why this node takes no clicks, with the fix. */ helper: Problem | null }
  | { node: string; item: null; problem: Problem };

/** Nodes in console order; a node the stream has not announced yet goes last. */
export function nodeOrder(view: RecommendationsView, order: readonly string[]): string[] {
  const known = order.filter((id) => id in view.nodes);
  return [...known, ...Object.keys(view.nodes).filter((id) => !known.includes(id))];
}

export function nodeRows(view: RecommendationsView, nodes: readonly string[], rec: Recommendation): NodeRow[] {
  return nodes.map((node) => {
    const answer = view.nodes[node];
    if (!answer) {
      const problem = view.problems[node] ?? { message: `${node} did not answer`, cause: '', fix: '' };
      return { node, item: null, problem };
    }
    // An agent from a release with a shorter catalog does not know this setting.
    const item = answer.items.find((i) => i.id === rec.id) ?? { id: rec.id, state: 'unknown', detail: `The agent on ${node} did not report this setting`, managed: false, last: null };
    return { node, item, helper: answer.one_click };
  });
}

/** recommended: some node has it to apply. done: every node has it. open: neither (not applicable, or not known). */
export type Standing = 'recommended' | 'open' | 'done';

export function standing(rows: readonly NodeRow[]): Standing {
  if (rows.some((r) => r.item?.state === 'not-applied')) return 'recommended';
  return rows.length > 0 && rows.every((r) => r.item?.state === 'applied') ? 'done' : 'open';
}

const RANK: Record<Standing, number> = { recommended: 0, open: 1, done: 2 };

/** Catalog order, with what is still recommended first and what is applied everywhere last. */
export function leadWithRecommended<T extends { standing: Standing }>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => RANK[a.standing] - RANK[b.standing]);
}

/** What one click can do on this row, if anything: apply what is recommended, undo what Sparkline applied. */
export function actionFor(rec: Recommendation, row: NodeRow): Verb | null {
  if (!row.item || !rec.one_click || row.helper) return null;
  if (row.item.state === 'not-applied') return 'apply';
  return row.item.state === 'applied' && row.item.managed ? 'undo' : null;
}

/** After a click: the node's state changed, or its helper reported a new failure. */
export function settled(before: NodeRecState, after: NodeRecState | undefined): boolean {
  if (!after) return false;
  return after.state !== before.state || (after.last !== null && !after.last.ok && after.last.ts !== before.last?.ts);
}

export function survivesReboot(rec: Recommendation): string {
  if (rec.persists === 'persistent') return 'Yes. It stays until it is undone.';
  return rec.one_click
    ? 'Not on its own. When Sparkline applies it, Sparkline applies it again at every boot until it is undone.'
    : 'No. It has to be applied again after every reboot.';
}

/** The words of the confirmation before a click. The node's root helper runs fixed actions from the release, so
 *  `commands` are the same change by hand, not what runs. */
export function confirmCopy(rec: Recommendation, node: string, verb: Verb): { title: string; consequences: string[]; commands: string[]; confirmLabel: string } {
  const apply = verb === 'apply';
  const reboot =
    rec.persists === 'persistent'
      ? 'The change survives a reboot.'
      : apply
        ? 'The setting is forgotten at a reboot, so Sparkline applies it again at every boot until it is undone.'
        : 'Sparkline stops applying the setting at boot.';
  return {
    title: `${apply ? 'Apply' : 'Undo'} “${rec.title}” on ${node}?`,
    consequences: [`Change ${node}: Sparkline's root helper on ${node} ${apply ? 'applies' : 'removes'} this setting.`, reboot],
    commands: apply ? rec.apply : rec.undo,
    confirmLabel: `${apply ? 'Apply' : 'Undo'} on ${node}`,
  };
}
