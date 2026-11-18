// First-run state, derived. The console owns the facts (Onboarding, NodeState.first_seen); everything the app shows
// about a first run is a pure function of them here, and nothing is stored twice.
import type { NodeState, Onboarding, OnboardingPatch } from './types';

/** A node this console has never received a sample from. Consoles before 0.3.0 send no `first_seen`: their nodes
 *  were set up long ago and all count as seen. */
export const isNewNode = (n: Pick<NodeState, 'first_seen'> | null | undefined): boolean => n?.first_seen === null;

/** The console's last try at a node ended without a stream: nothing answered, or an agent turned it away. */
export const couldNotConnect = (status: NodeState['status'] | undefined): boolean => status === 'offline' || status === 'error';

/** A new node the console has tried and could not use: "Not connected yet", a setup step and not an outage. */
export const needsSetup = (n: Pick<NodeState, 'first_seen' | 'status'> | null | undefined): boolean => isNewNode(n) && couldNotConnect(n?.status);

/** Where the console looks for a node's agent: "192.168.1.11:9750" from its url. */
export function agentAddress(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

interface FixStep {
  /** The words of the step, with its `backtick` names. They end in a colon when a command follows. */
  text: string;
  /** What the step says to run. null: nothing to run. */
  command: string | null;
}

/** A fix as the steps it is written in (console/nodes.py classify): one per sentence. A step that has something to
 *  run ends in it, after a colon, as a `backtick` span of several words: the words are shown without it and the
 *  command once, in a box of its own. A single word in backticks is a name (a key, a path) and stays in the words.
 *  A full stop inside a `backtick` span or a name (`*.toml`) ends nothing. */
export function fixSteps(fix: string | null | undefined): FixStep[] {
  const sentences = (fix ?? '').match(/(?:`[^`]*`|[^`.]|\.(?!\s|$))+\.?/g) ?? [];
  return sentences.map((s) => s.trim()).filter(Boolean).map((text) => {
    const run = /^(.*:)\s*`([^`]*\S\s+\S[^`]*)`\.?$/.exec(text);
    return run?.[1] && run[2] ? { text: run[1], command: run[2] } : { text, command: null };
  });
}

/** How far the console's request got. `no-answer`: nothing answered at the address (refused, timed out, no route).
 *  `turned-away`: an agent answered and said no (wrong token, another protocol version). */
type Reach = 'no-answer' | 'turned-away';
export const reachOf = (status: NodeState['status']): Reach => (status === 'error' ? 'turned-away' : 'no-answer');

/** The console's next automatic attempt. `secs` whole seconds left (0: trying now); `left` is the share of the wait
 *  still to go, 1 at the moment the wait was learned and 0 when the attempt starts. */
export function retryWait(next: number | null | undefined, learned: number, now: number): { secs: number; left: number } {
  if (next == null || next <= now) return { secs: 0, left: 0 };
  const span = next - learned;
  return { secs: Math.ceil(next - now), left: span > 0 ? Math.min(1, (next - now) / span) : 1 };
}

/** `row` after `patch`, as the console merges it (console/onboarding.py): the app shows the result at once. */
export function mergeOnboarding(row: Onboarding, patch: OnboardingPatch, now: number): Onboarding {
  const seen = [...new Set([...row.seen, ...(patch.seen ?? [])])].sort();
  if (patch.finished === undefined) return { ...row, seen };
  return patch.finished ? { ...row, seen, finished: row.finished ?? now, reopened: false } : { ...row, seen, finished: null, reopened: true };
}

/** Where the person is in the getting-started guide. `first`: signed in, nothing opened yet. `resumed`: they opened
 *  something and came back. `finished`: completed or dismissed (or no one has signed in, or an older console). */
export type GuideStage = 'first' | 'resumed' | 'finished';

export function guideStage(ob: Onboarding | null | undefined): GuideStage {
  if (!ob || ob.started === null || ob.finished !== null) return 'finished';
  return ob.seen.length ? 'resumed' : 'first';
}

export type GuideView = 'full' | 'strip' | 'gone';

/** How the overview draws the guide. `open` is this browser's choice (Collapse, Show all); null follows the console:
 *  the full panel on a first visit and for a guide someone brought back, one line once the person has been
 *  somewhere. */
export function guideView(ob: Onboarding | null | undefined, open: boolean | null): GuideView {
  const stage = guideStage(ob);
  if (stage === 'finished') return 'gone';
  return (open ?? (stage === 'first' || ob?.reopened === true)) ? 'full' : 'strip';
}
