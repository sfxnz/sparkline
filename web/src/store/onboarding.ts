import { api } from '../lib/api';
import { mergeOnboarding } from '../lib/onboarding';
import type { Onboarding, OnboardingPatch } from '../lib/types';
import { serverNow, useCluster } from './cluster';

/** Patches go to the console one at a time, in the order the person made them. */
let queue: Promise<unknown> = Promise.resolve();
/** Patches sent and not yet answered. While there are any, the screen shows what the person did, and an answer or
 *  a broadcast that describes an earlier moment (Dismiss, then Bring it back before the first answer) is not shown. */
let unanswered = 0;

/**
 * Tell the console how far the person has come (an item opened, the guide dismissed or reopened). The result shows
 * at once, and the console's answer to the last patch replaces it. If the console cannot be reached, the old state
 * comes back, so the screen never claims something a reload would undo.
 */
export function patchOnboarding(patch: OnboardingPatch): Promise<void> {
  const { onboarding: before, setOnboarding } = useCluster.getState();
  if (!before) return Promise.resolve();
  setOnboarding(mergeOnboarding(before, patch, serverNow()));
  unanswered++;
  const sent = queue.then(() => api.updateOnboarding(patch));
  queue = sent.catch(() => undefined);
  const settle = (row: Onboarding) => {
    unanswered--;
    if (!unanswered) setOnboarding(row);
  };
  return sent.then(settle, () => { settle(before); });
}

/** The console's broadcast after a change, from this tab or another. */
export function receiveOnboarding(row: Onboarding): void {
  if (!unanswered) useCluster.getState().setOnboarding(row);
}
