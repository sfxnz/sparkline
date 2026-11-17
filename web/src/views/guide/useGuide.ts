import { useEffect, useMemo } from 'react';
import { serverTitle } from '../../lib/llm';
import { guideStage, guideView, type GuideStage, type GuideView } from '../../lib/onboarding';
import { useBench } from '../../store/bench';
import { useCluster } from '../../store/cluster';
import { loadGuideFacts, useGuideFacts } from '../../store/guide';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import { useAcross } from '../overview/hooks';
import { buildGuide, GUIDE_ITEMS, type Guide, type GuideItem } from './items';

/** The guide as every surface draws it (the overview panel, the sidebar entry, the phone chip): where the person is,
 *  how to show it, and the rows with what is done. All derived; see items.ts. */
export function useGuide(items: readonly GuideItem[] = GUIDE_ITEMS): { stage: GuideStage; view: GuideView; guide: Guide; ready: boolean } {
  const onboarding = useCluster((s) => s.onboarding);
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const open = usePrefs((s) => s.guideOpen);
  const facts = useGuideFacts();
  // A run that arrives on the stream counts at once, before the next fetch.
  const streamedRuns = useBench((s) => Object.keys(s.runs).length);
  const found = useAcross(
    order,
    () => order.flatMap((id) => (liveStore.latest(id)?.llm ?? []).map((s) => `${id}\u0001${serverTitle(s)}`)).join('\u0000'),
    Object.is,
  );
  const stage = guideStage(onboarding);

  useEffect(() => {
    if (stage !== 'finished') void loadGuideFacts();
  }, [stage]);

  const guide = useMemo(
    () =>
      buildGuide(
        {
          nodes: order.flatMap((id) => nodes[id] ?? []),
          servers: found ? found.split('\u0000').map((s) => { const [node = '', name = ''] = s.split('\u0001'); return { node, name }; }) : [],
          notifyChannels: facts.notifyChannels,
          benchRuns: facts.benchRuns === null && !streamedRuns ? null : Math.max(facts.benchRuns ?? 0, streamedRuns),
          seen: new Set(onboarding?.seen),
        },
        items,
      ),
    [order, nodes, found, facts, streamedRuns, onboarding, items],
  );
  return { stage, view: guideView(stage, open), guide, ready: facts.notifyChannels !== null && facts.benchRuns !== null };
}
