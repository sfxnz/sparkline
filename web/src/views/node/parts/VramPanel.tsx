import { gpuColor } from '../../../charts/theme';
import { Panel } from '../../../design/components/Panel';
import { Skeleton } from '../../../design/components/Skeleton';
import { NoData, Unsupported } from '../../../design/components/Unsupported';
import { lostGpu } from '../../../lib/capabilities';
import { formatBytes, formatPercent } from '../../../lib/format';
import { gpuKey } from '../../../lib/metrics';
import type { GpuInfo } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { lastKnownValue } from '../../shared/live';
import { useBufferTs, useFreshness } from './hooks';
import { StaleAge } from './MemoryHero';
import { gpuSelector } from './selectors';
import { useGpuGap } from './useGpuGap';

const pct = (n: number) => formatPercent(n, n > 0 && n < 10 ? 1 : 0);

/** One bar per GPU with memory of its own: how full each card's VRAM is. */
export function VramPanel({ nodeId, gpus }: { nodeId: string; gpus: readonly GpuInfo[] }) {
  const { stale, waiting } = useFreshness(nodeId);
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const answering = gpus.filter((g) => !lostGpu(info, g.index));
  const names = new Set(answering.map((g) => g.name));
  const [shared] = names.size === 1 ? names : [];
  const whose = shared ? `${answering.length === 1 ? 'The' : 'Each'} ${shared}’s` : 'Each GPU’s';
  return (
    <Panel title="GPU memory" subtitle={`${whose} own memory (VRAM), apart from system memory`} actions={stale ? <StaleAge nodeId={nodeId} /> : null} busy={waiting || undefined}>
      <ul className={`nvram${stale ? ' nvram--stale' : ''}`} aria-label="VRAM by GPU">
        {gpus.map((g) => (
          <VramBar key={g.index} nodeId={nodeId} gpu={g} model={shared ? null : g.name} />
        ))}
      </ul>
    </Panel>
  );
}

function VramBar({ nodeId, gpu, model }: { nodeId: string; gpu: GpuInfo; model: string | null }) {
  const { index } = gpu;
  const key = gpuKey(index, 'vram_used');
  const live = useLatest(nodeId, gpuSelector(index, 'vram_used'));
  const { stale, waiting } = useFreshness(nodeId);
  const gap = useGpuGap(nodeId, index)(key);
  const fallback = live === null && stale;
  useBufferTs(nodeId, fallback);
  const used = live ?? (fallback ? lastKnownValue(nodeId, key) : null);
  const total = gpu.vram_total ?? null;
  const name = `GPU ${index}`;
  const share = used !== null && total ? Math.min(100, (100 * used) / total) : null;

  const head = (
    <div className="nvram__head">
      <span className="nvram__name">
        <span className="ngpu-section__swatch" style={{ background: gpuColor(index) }} aria-hidden="true" />
        {name}
      </span>
      {model && model !== name ? <span className="nvram__model" title={model}>{model}</span> : null}
    </div>
  );

  if (waiting && !gap) {
    return (
      <li className="nvram__gpu" aria-busy="true">
        {head}
        <Skeleton width={150} height={22} radius={7} />
        <Skeleton height={8} radius={4} />
      </li>
    );
  }

  if (gap || used === null) {
    return (
      <li className="nvram__gpu">
        {head}
        <div className="nvram__value">{gap ? <Unsupported gap={gap} /> : stale ? <span className="nmuted">No recent reading</span> : <NoData />}</div>
        <div className="nvram__bar nvram__bar--empty" aria-hidden="true" />
      </li>
    );
  }

  const label = total ? `${name}: ${formatBytes(used)} of ${formatBytes(total)} in use (${pct(share ?? 0)})` : `${name}: ${formatBytes(used)} in use`;
  return (
    <li className="nvram__gpu">
      {head}
      <span className="visually-hidden">{label}.</span>
      <div className="nvram__value num" aria-hidden="true">
        <span className="nvram__used">{formatBytes(used)}</span>
        <span className="nvram__of">{total ? `of ${formatBytes(total)}` : 'in use · total not reported'}</span>
        {share !== null ? <span className="nvram__pct">{pct(share)}</span> : null}
      </div>
      {share !== null ? (
        <div className="nvram__bar" aria-hidden="true">
          <span style={{ width: `${share.toFixed(2)}%`, background: gpuColor(index) }} />
        </div>
      ) : (
        <div className="nvram__bar nvram__bar--empty" aria-hidden="true" />
      )}
    </li>
  );
}
