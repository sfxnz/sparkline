import { act, render, screen, within } from '@testing-library/react';
import type { ModelServerSample, NodeInfo, NodeState, Sample } from '../../../lib/types';
import { useCluster } from '../../../store/cluster';
import { useConnection } from '../../../store/connection';
import { liveStore } from '../../../store/live';
import sampleJson from '../../../test/fixtures/sample.json';
import gb10Info from '../../../test/fixtures/platforms/gb10/info.json';
import { ModelServersPanel } from './ModelServers';

const NODE = 'mtest';
const TS = 1_800_000_000;
const base = sampleJson as unknown as Sample;
const [vllm] = base.llm as [ModelServerSample, ModelServerSample];
const info = (p: Partial<NodeInfo> = {}): NodeInfo => ({ ...(gb10Info as unknown as NodeInfo), node_id: NODE, ...p });

const open = (sample: Partial<Sample> | null, p: Partial<NodeState> = {}) => {
  const node: NodeState = { node_id: NODE, url: 'http://x:9750', status: 'online', since: 0, last_sample_ts: TS, error: null, info: info(), next_retry_ts: null, ...p };
  useCluster.setState({ clockOffset: 0, nodes: { [NODE]: node } });
  if (sample) {
    act(() => {
      liveStore.pushSample({ ...base, ...sample, node_id: NODE, ts: TS });
      liveStore.flush();
    });
  }
  render(<ModelServersPanel nodeId={NODE} />);
  return screen.queryByRole('region', { name: 'Model servers' });
};
const stat = (within_: HTMLElement, label: string) => within(within_).getByText(label, { selector: '.stat__label' }).closest('.stat') as HTMLElement;

beforeEach(() => {
  liveStore.removeNode(NODE);
  useConnection.setState({ status: 'live', everLive: true });
  vi.useFakeTimers({ now: (vllm.started_ts ?? 0) * 1000 + 3 * 3600_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ModelServersPanel', () => {
  it('shows each server with its model, what it is, and where it runs', () => {
    open({});
    const card = screen.getByRole('region', { name: 'Model server on port 8000' });
    expect(within(card).getByRole('heading', { name: 'Qwen3-32B' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Ready');
    expect(card).toHaveTextContent('vLLM 0.11.0 · port 8000 · container vllm-qwen3 · pid 4242 · up 3 h 00 min');
    expect(card).toHaveTextContent('32,768 token context');
  });

  it('renders a value, a field with nothing to say now, and a field the server does not report differently', () => {
    open({});
    const card = screen.getByRole('region', { name: 'Model server on port 8000' });
    expect(stat(card, 'Requests waiting')).toHaveTextContent('0');
    expect(stat(card, 'Generation')).toHaveTextContent('212');
    expect(stat(card, 'First token, median')).toHaveTextContent('—');
    expect(stat(card, 'First token, median')).toHaveTextContent('No request finished in the last minute');
    expect(stat(card, 'KV cache used')).toHaveTextContent('Not reported by this server');
    expect(stat(card, 'KV cache used')).not.toHaveTextContent(/\d/);
    expect(stat(card, 'Memory held')).toHaveTextContent('20.0GiB');
    expect(stat(card, 'Memory held')).toHaveTextContent('GPU memory of its process');
  });

  it('shows a server that stopped answering as down, with no readings and no uptime', () => {
    open({});
    const card = screen.getByRole('region', { name: 'Model server on port 9931' });
    expect(within(card).getByRole('heading', { name: 'Port 9931' })).toBeInTheDocument();
    expect(card).toHaveTextContent('Down');
    expect(card).not.toHaveTextContent('up ');
    expect(stat(card, 'Requests running')).toHaveTextContent('No reading from this server');
    expect(stat(card, 'Requests running')).not.toHaveTextContent(/\d/);
  });

  it('shows the problem the agent reports for a server', () => {
    open({ llm: [{ ...vllm, problem: 'llama.cpp serves no metrics: start it with --metrics' }] });
    expect(screen.getByText('llama.cpp serves no metrics: start it with --metrics')).toBeInTheDocument();
  });

  it('says where it looked when the node runs no model server', () => {
    expect(open({ llm: [] })).toHaveTextContent('No model server found on this node. Sparkline asks ports 8000, 8080, 9931, 30000, any port a process names with --port, and ports Docker publishes. List another under [[model_servers]] in agent.toml.');
  });

  it('asks for an agent update when the agent predates model servers', () => {
    expect(open({ llm: undefined })).toHaveTextContent(`Update the agent on ${NODE} to see model servers.`);
    expect(screen.queryByText(/No model server found/)).not.toBeInTheDocument();
  });

  it("gives the agent's own reason when it does not look for model servers", () => {
    const reason = 'Model server discovery is off in agent.toml and no [[model_servers]] are listed';
    const panel = open({ llm: null }, { info: info({ unsupported: [{ metric: 'llm', reason, kind: 'agent' }] }) });
    expect(panel).toHaveTextContent('Not collected yet');
    expect(panel).not.toHaveTextContent('Update the agent');
  });

  it('is a busy placeholder until the first sample', () => {
    expect(open(null)).toHaveAttribute('aria-busy', 'true');
  });

  it('is absent for a silent node that never sent a sample', () => {
    expect(open(null, { status: 'offline' })).toBeNull();
  });
});
