import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../design/components/Button';
import { Panel } from '../../design/components/Panel';
import { Table, type Column } from '../../design/components/Table';
import { DASH } from '../../lib/format';
import type { NodeState } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { stopSession } from '../../store/session';
import { api, problemOf } from '../../lib/api';
import { ProblemBanner } from '../alerts/parts/Banner';
import { SettingRow } from './parts';
import '../../app/ConnectionIndicator.css';

const COLUMNS: readonly Column<NodeState>[] = [
  { id: 'node', header: 'Node', render: (n) => <span className="t-headline">{n.node_id}</span> },
  { id: 'agent', header: 'Agent', render: (n) => n.info?.agent_version ?? <span className="t-tertiary">Not connected yet</span> },
  { id: 'driver', header: 'NVIDIA driver', render: (n) => n.info?.driver ?? DASH },
  { id: 'cuda', header: 'CUDA', render: (n) => n.info?.cuda ?? DASH },
  { id: 'gpu', header: 'GPU', render: (n) => n.info?.gpus[0]?.name ?? DASH },
  { id: 'kernel', header: 'Kernel', render: (n) => (n.info ? <code className="set-code">{n.info.kernel}</code> : DASH) },
];

export function AboutSection() {
  const version = useCluster((s) => s.cluster?.version);
  const demo = useCluster((s) => s.cluster?.demo ?? false);
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const rows = order.map((id) => nodes[id]).filter((n): n is NodeState => n !== undefined);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<ReturnType<typeof problemOf> | null>(null);

  const signOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      await api.logout();
      stopSession();
      window.location.assign('/login');
    } catch (e) {
      setError(problemOf(e, 'sign out'));
      setSigningOut(false);
    }
  };

  return (
    <Panel title="About" subtitle="Versions reported by the console and each node's agent.">
      <div className="set-rows">
        <SettingRow id="set-version" title="Sparkline" description={demo ? 'Running with simulated telemetry (sparkline --demo). Nothing here touches real hardware.' : 'Console and web app.'}>
          <span className="set-version">
            <span className="num t-headline">{version ? `v${version}` : DASH}</span>
            {demo ? <span className="conn__demo">Demo</span> : null}
          </span>
        </SettingRow>
        <div className="set-table">
          <Table caption="Node software versions" columns={COLUMNS} rows={rows} rowKey={(n) => n.node_id} empty="No nodes are configured yet." />
        </div>
        <SettingRow id="set-signout" title="Sign out" description={demo ? 'Authentication is usually off in demo mode, so you may be signed straight back in.' : 'Ends this browser session. You will need the console token to sign in again.'}>
          <Button size="sm" variant="secondary" icon={<LogOut />} disabled={signingOut} onClick={() => { void signOut(); }}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </SettingRow>
        {error ? <ProblemBanner problem={error} /> : null}
      </div>
    </Panel>
  );
}
