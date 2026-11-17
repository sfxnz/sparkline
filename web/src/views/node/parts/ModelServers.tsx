import { Panel } from '../../../design/components/Panel';
import { Skeleton } from '../../../design/components/Skeleton';
import { Stat } from '../../../design/components/Stat';
import { StatusPill } from '../../../design/components/StatusPill';
import { Unsupported } from '../../../design/components/Unsupported';
import { useHashTarget } from '../../../design/useHashTarget';
import { useNow } from '../../../design/useNow';
import { notReported } from '../../../lib/capabilities';
import { formatDuration } from '../../../lib/format';
import { DEFAULT_PORTS, FIELD_SPECS, LLM_FIELDS, reading, SERVER_PILL, serverTitle, STATE_LABEL, type LlmField } from '../../../lib/llm';
import type { ModelServerSample, Sample } from '../../../lib/types';
import { serverNow, useCluster } from '../../../store/cluster';
import { useLatest } from '../../../store/live';
import { useFreshness } from './hooks';

const selectServers = (s: Sample | null) => s?.llm ?? null;

const MEM_FROM: Record<string, string> = { server: 'Reported by the server', process: 'GPU memory of its process' };
const tokens = new Intl.NumberFormat('en-GB');

export function ModelServersPanel({ nodeId }: { nodeId: string }) {
  const servers = useLatest(nodeId, selectServers);
  const info = useCluster((s) => s.nodes[nodeId]?.info);
  const { stale, hasData, waiting } = useFreshness(nodeId);
  const declared = notReported(info, 'llm');
  // `<node page>#model-servers` (the getting-started guide) lands on this panel, not on the top of the page.
  useHashTarget('model-servers');
  if (!waiting && !hasData) return null;
  return (
    <Panel id="model-servers" title="Model servers" subtitle="Found on this node’s listening ports, read every 2 s" busy={waiting || undefined}>
      {waiting ? (
        <Skeleton height={56} radius={8} />
      ) : servers?.length ? (
        <div className={`nllm${stale ? ' nllm--stale' : ''}`}>
          {servers.map((s) => <ModelServerCard key={s.port} server={s} />)}
        </div>
      ) : declared ? (
        <Unsupported gap={declared} block />
      ) : servers ? (
        <p className="nmuted">
          No model server found on this node. Sparkline asks ports {DEFAULT_PORTS.join(', ')}, any port a process names with <code>--port</code>, and ports Docker publishes. List another under <code>[[model_servers]]</code> in <code>agent.toml</code>.
        </p>
      ) : (
        <p className="nmuted">Update the agent on {nodeId} to see model servers.</p>
      )}
    </Panel>
  );
}

function ModelServerCard({ server }: { server: ModelServerSample }) {
  const title = serverTitle(server);
  return (
    <section className="nllm__server" aria-label={`Model server on port ${String(server.port)}`}>
      <header className="nllm__head">
        <h3 className="nllm__title" title={title}>{title}</h3>
        <StatusPill status={SERVER_PILL[server.state]} label={STATE_LABEL[server.state]} size="sm" />
      </header>
      <p className="nfoot"><Facts server={server} /></p>
      {server.models.length > 1 || server.models[0]?.context_len ? (
        <ul className="nllm__models nfoot" aria-label="Loaded models">
          {server.models.map((m) => (
            <li key={m.name}>{server.models.length > 1 ? `${m.name} · ` : ''}{m.context_len ? `${tokens.format(m.context_len)} token context` : 'context length not reported'}</li>
          ))}
        </ul>
      ) : null}
      {server.problem ? <p className="nllm__problem">{server.problem}</p> : null}
      <div className="nstats nllm__stats">
        {LLM_FIELDS.map((f) => <FieldStat key={f} server={server} field={f} />)}
      </div>
    </section>
  );
}

function Facts({ server }: { server: ModelServerSample }) {
  useNow(1000);
  const up = server.state !== 'down' && server.started_ts ? `up ${formatDuration(serverNow() - server.started_ts)}` : null;
  const facts = [
    [server.software, server.version].filter(Boolean).join(' ') || 'Unidentified server',
    `port ${String(server.port)}`,
    server.container ? `container ${server.container}` : null,
    server.pid ? `pid ${String(server.pid)}` : null,
    up,
  ];
  return <>{facts.filter(Boolean).join(' · ')}</>;
}

function FieldStat({ server, field }: { server: ModelServerSample; field: LlmField }) {
  const spec = FIELD_SPECS[field];
  const r = reading(server, field);
  if (r.kind === 'unreported') return <Stat label={spec.label} value={null} format={spec.format} unsupported={r.gap} />;
  const footer = r.kind === 'empty' ? r.why : field === 'mem_bytes' ? MEM_FROM[server.mem_source ?? ''] : undefined;
  return <Stat label={spec.label} value={r.kind === 'value' ? r.value : null} format={spec.format} footer={footer} />;
}
