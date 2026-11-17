import { Compass, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { paths } from '../../app/routes';
import { Button } from '../../design/components/Button';
import { Panel } from '../../design/components/Panel';
import { StatusPill, nodeDisplayStatus } from '../../design/components/StatusPill';
import { Table, type Column } from '../../design/components/Table';
import { DASH } from '../../lib/format';
import { guideStage, isNewNode } from '../../lib/onboarding';
import type { NodeState } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { reopenGuide } from '../../store/guide';
import { stopSession } from '../../store/session';
import { api, problemOf } from '../../lib/api';
import { ProblemBanner } from '../alerts/parts/Banner';
import { SettingRow } from './parts';
import '../../app/ConnectionIndicator.css';
import { gpuSetName } from '../../lib/platform';

const COLUMNS: readonly Column<NodeState>[] = [
  { id: 'node', header: 'Node', render: (n) => <span className="t-headline">{n.node_id}</span> },
  // No agent version to show: say where the node stands instead, in the words every other screen uses for it.
  { id: 'agent', header: 'Agent', render: (n) => n.info?.agent_version ?? <StatusPill status={nodeDisplayStatus(n.status, null, true, isNewNode(n))} variant="inline" size="sm" /> },
  { id: 'driver', header: 'NVIDIA driver', render: (n) => n.info?.driver ?? DASH },
  { id: 'cuda', header: 'CUDA', render: (n) => n.info?.cuda ?? DASH },
  { id: 'gpu', header: 'GPU', render: (n) => (n.info ? gpuSetName(n.info) : null) ?? DASH },
  { id: 'kernel', header: 'Kernel', render: (n) => (n.info ? <code className="set-code">{n.info.kernel}</code> : DASH) },
];

export function AboutSection() {
  const version = useCluster((s) => s.cluster?.version);
  const demo = useCluster((s) => s.cluster?.demo ?? false);
  const order = useCluster((s) => s.order);
  const nodes = useCluster((s) => s.nodes);
  const rows = order.map((id) => nodes[id]).filter((n): n is NodeState => n !== undefined);
  const onboarding = useCluster((s) => s.onboarding);
  const [, navigate] = useLocation();
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
        {onboarding ? (
          <SettingRow
            id="set-guide"
            title="Getting started"
            description={guideStage(onboarding) === 'finished'
              ? 'The short guide to what Sparkline does. It was put away for everyone who uses this console. Open it again on the overview.'
              : 'The short guide to what Sparkline does. It is open on the overview.'}
          >
            <Button size="sm" variant="secondary" icon={<Compass />} onClick={() => { void reopenGuide(); navigate(paths.overview); }}>
              Open getting started
            </Button>
          </SettingRow>
        ) : null}
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
