// The getting-started guide's facts and actions. What is done is derived (views/guide/items.ts) from the cluster and
// from two counts the stream does not carry, fetched here once per visit while the guide is unfinished. The only
// state the guide writes is the console's Onboarding (store/onboarding.ts) and one per-browser preference.
import { create } from 'zustand';
import { api, benchApi } from '../lib/api';
import { guideStage, guideView } from '../lib/onboarding';
import { useCluster } from './cluster';
import { patchOnboarding } from './onboarding';
import { usePrefs } from './prefs';
import { useUi } from './ui';

interface GuideFacts {
  /** Notification channels configured on the console. null: not known yet. */
  notifyChannels: number | null;
  /** 1 when the console has stored a benchmark run, 0 when it has none. null: not known yet. */
  benchRuns: number | null;
}

export const useGuideFacts = create<GuideFacts>()(() => ({ notifyChannels: null, benchRuns: null }));

let loading: Promise<void> | null = null;

/** Ask the console for the two counts. Calls made while one is in flight share it; a failure keeps what was known. */
export function loadGuideFacts(): Promise<void> {
  loading ??= Promise.all([
    api.notifyChannels().then((rows) => rows.length, () => null),
    benchApi.runs({ limit: 1 }).then((runs) => runs.length, () => null),
  ])
    .then(([notifyChannels, benchRuns]) => {
      useGuideFacts.setState((was) => ({ notifyChannels: notifyChannels ?? was.notifyChannels, benchRuns: benchRuns ?? was.benchRuns }));
    })
    .finally(() => { loading = null; });
  return loading;
}

export const markGuideItem = (id: string) => patchOnboarding({ seen: [id] });

export function finishGuide(how: 'dismissed' | 'complete'): Promise<void> {
  useUi.setState({ guideLeft: how });
  return patchOnboarding({ finished: true });
}

export const setGuideOpen = (open: boolean) => { usePrefs.getState().set({ guideOpen: open }); };

/** Bring the guide to the person: the overview scrolls to it (the caller navigates there). One line becomes every
 *  row, since they asked for it; a guide already shown in full leaves this browser's preference alone. */
export function wantGuide(): void {
  const view = guideView(guideStage(useCluster.getState().onboarding), usePrefs.getState().guideOpen);
  if (view === 'strip') setGuideOpen(true);
  useUi.setState({ guideWanted: true, guideLeft: null });
}

/** "Open getting started" and "Bring it back". A guide still in progress is only brought into view: reopening it
 *  would stop it from putting itself away when its last row is done. */
export function reopenGuide(): Promise<void> {
  setGuideOpen(true);
  useUi.setState({ guideWanted: true, guideLeft: null });
  if (useCluster.getState().onboarding?.finished == null) return Promise.resolve();
  return patchOnboarding({ finished: false });
}
