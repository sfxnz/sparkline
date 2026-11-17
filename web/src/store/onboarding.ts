import { api } from '../lib/api';
import { mergeOnboarding } from '../lib/onboarding';
import type { OnboardingPatch } from '../lib/types';
import { serverNow, useCluster } from './cluster';

/**
 * Tell the console how far the person has come (an item opened, the guide dismissed or reopened). The result shows
 * at once, and the console's answer replaces it. If the console cannot be reached, the old state comes back, so the
 * screen never claims something a reload would undo.
 */
export function patchOnboarding(patch: OnboardingPatch): Promise<void> {
  const { onboarding: before, setOnboarding } = useCluster.getState();
  if (!before) return Promise.resolve();
  setOnboarding(mergeOnboarding(before, patch, serverNow()));
  return api.updateOnboarding(patch).then(setOnboarding, () => { setOnboarding(before); });
}
