// Node tab modules, one lazy chunk each. Every module default-exports a component taking { nodeId }.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { NodeTab } from '../../app/routes';

export interface NodeTabProps {
  nodeId: string;
}

type TabModule = Promise<{ default: ComponentType<NodeTabProps> }>;
let summaryChunk: TabModule | null = null;
/** Start loading the Summary chunk ahead of navigation (overview card hover/focus), so opening a node rarely
 *  shows the fallback at all. Idempotent. */
export const preloadSummary = (): TabModule => (summaryChunk ??= import('./Summary'));

export const TAB_COMPONENTS: Record<NodeTab, LazyExoticComponent<ComponentType<NodeTabProps>>> = {
  summary: lazy(preloadSummary),
  gpu: lazy(() => import('./Gpu')),
  memory: lazy(() => import('./Memory')),
  cpu: lazy(() => import('./Cpu')),
  network: lazy(() => import('./Network')),
  storage: lazy(() => import('./Storage')),
  thermals: lazy(() => import('./Thermals')),
  processes: lazy(() => import('./Processes')),
};
