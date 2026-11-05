import { ChevronDown } from 'lucide-react';
import { useCallback } from 'react';
import { gpuColor } from '../../../charts/theme';
import { prefersReducedMotion } from '../../../design/motion';
import { byWhat, gpuConditions, sameGpuConditions, type GpuCondition } from '../../../lib/condition';
import { gpuList } from '../../../lib/gpu';
import type { NodeInfo, Sample } from '../../../lib/types';
import { quietGpusOf } from '../../../store/attention';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { SEVERITY_META } from './Notices';

const ONE_ROW_PER_GPU_UP_TO = 3;

export const gpuSectionId = (nodeId: string, index: number) => `ngpu-${nodeId}-${index}`;

interface Row {
  level: GpuCondition['level'];
  indexes: number[];
  text: string;
}

function rowsOf(conditions: readonly GpuCondition[]): Row[] {
  const rows: Row[] = conditions.length > ONE_ROW_PER_GPU_UP_TO
    ? byWhat(conditions).map((g) => ({ level: g.condition.level, indexes: g.indexes, text: g.condition.what }))
    : conditions.map((c) => ({ level: c.level, indexes: [c.index], text: c.reading }));
  return rows.toSorted((a, b) => Number(b.level === 'critical') - Number(a.level === 'critical'));
}

function jumpTo(id: string) {
  const section = document.getElementById(id);
  section?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  section?.querySelector<HTMLElement>('.panel__title')?.focus({ preventScroll: true });
}

/** The GPU tab's one-glance answer on a node with several GPUs: which GPUs the status pill is raised for and what
 *  their readings show, each row a jump to that GPU's section. Nothing while every GPU is fine or the node is not
 *  live. */
export function GpuAttention({ nodeId, info }: { nodeId: string; info: NodeInfo | null | undefined }) {
  const online = useCluster((s) => s.nodes[nodeId]?.status === 'online');
  const conditions = useLatest(nodeId, useCallback((s: Sample | null) => gpuConditions(info, s, quietGpusOf(nodeId, info)), [nodeId, info]), sameGpuConditions);
  if (!online || !conditions.length) return null;
  return (
    <ul className="nnotes ngpu-attn" aria-label="GPU needs attention">
      {rowsOf(conditions).map((row) => {
        const m = SEVERITY_META[row.level];
        const Icon = m.icon;
        const [first = 0] = row.indexes;
        return (
          <li key={row.indexes.join()}>
            <button type="button" className={`nnote ngpu-attn__row ${m.tone}`} onClick={() => { jumpTo(gpuSectionId(nodeId, first)); }}>
              <Icon className="nnote__icon" aria-hidden="true" />
              <span className="ngpu-attn__swatches" aria-hidden="true">
                {row.indexes.map((i) => <span key={i} className="ngpu-section__swatch" style={{ background: gpuColor(i) }} />)}
              </span>
              <span className="nnote__text ngpu-attn__text">
                <span className="visually-hidden">{m.label}: </span>
                <strong>{gpuList(row.indexes)}</strong>
                <span className="nnote__msg ngpu-attn__reading">{row.text}</span>
              </span>
              <ChevronDown className="ngpu-attn__go" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
