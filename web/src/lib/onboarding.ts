// First-run state, derived. The console owns the facts (Onboarding, NodeState.first_seen); everything the app shows
// about a first run is a pure function of them here, and nothing is stored twice.
import type { NodeState, Onboarding, OnboardingPatch } from './types';

/** A node this console has never received a sample from. Consoles before 0.3.0 send no `first_seen`: their nodes
 *  were set up long ago and all count as seen. */
export const isNewNode = (n: Pick<NodeState, 'first_seen'> | null | undefined): boolean => n?.first_seen === null;

/** A new node the console has tried and could not use: "Not connected yet", a setup step and not an outage. */
export const needsSetup = (n: Pick<NodeState, 'first_seen' | 'status'> | null | undefined): boolean =>
  isNewNode(n) && (n?.status === 'offline' || n?.status === 'error');

/** `row` after `patch`, as the console merges it (console/onboarding.py): the app shows the result at once. */
export function mergeOnboarding(row: Onboarding, patch: OnboardingPatch, now: number): Onboarding {
  const finished = patch.finished === false ? null : patch.finished && row.finished === null ? now : row.finished;
  return { ...row, seen: [...new Set([...row.seen, ...(patch.seen ?? [])])].sort(), finished };
}

/** Where the person is in the getting-started guide. `first`: signed in, nothing opened yet. `resumed`: they opened
 *  something and came back. `finished`: completed or dismissed (or no one has signed in, or an older console). */
export type GuideStage = 'first' | 'resumed' | 'finished';

export function guideStage(ob: Onboarding | null | undefined): GuideStage {
  if (!ob || ob.started === null || ob.finished !== null) return 'finished';
  return ob.seen.length ? 'resumed' : 'first';
}

export type GuideView = 'full' | 'strip' | 'gone';

/** How the overview draws the guide. `open` is this browser's choice (Collapse, Show all); null follows the stage:
 *  the full panel on a first visit, one line once the person has been somewhere. */
export function guideView(stage: GuideStage, open: boolean | null): GuideView {
  if (stage === 'finished') return 'gone';
  return (open ?? stage === 'first') ? 'full' : 'strip';
}
