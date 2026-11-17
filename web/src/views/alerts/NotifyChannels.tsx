import { BellOff, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../design/components/Button';
import { EmptyState } from '../../design/components/EmptyState';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { StatusPill } from '../../design/components/StatusPill';
import { Table, type Column } from '../../design/components/Table';
import { api, problemOf } from '../../lib/api';
import { formatClock } from '../../lib/format';
import type { ChannelKind, NotifyChannelStatus, Problem, Severity } from '../../lib/types';
import { RowsSkeleton } from '../placeholders';
import { Banner, ProblemBanner } from './parts/Banner';
import { RelTime } from './parts/RelTime';

const POLL_MS = 15_000;
const KIND_LABEL: Record<ChannelKind, string> = { ntfy: 'ntfy', discord: 'Discord', slack: 'Slack', webhook: 'Webhook' };
const SENDS: Record<Severity, string> = { info: 'Every alert', warning: 'Warning and above', critical: 'Critical only' };
const SNIPPET = `[[notify]]
name = "phone"
kind = "ntfy"            # or "discord", "slack", "webhook"
url = "https://ntfy.sh/<your-topic>"`;

type Load = { status: 'loading' } | { status: 'error'; problem: Problem } | { status: 'ready'; rows: NotifyChannelStatus[] };
/** What the last "Send test" did: `problem` is null when the channel took the message. */
interface Tested {
  name: string;
  problem: Problem | null;
}

function LastDelivery({ row }: { row: NotifyChannelStatus }) {
  const { last, pending, retry_at } = row;
  return (
    <div className="notify-last">
      {last ? (
        <span className="notify-last__result">
          <StatusPill size="sm" status={last.ok ? 'healthy' : 'error'} label={last.ok ? 'Delivered' : 'Failed'} />
          <span className="t-footnote">
            {last.test ? 'Test, ' : ''}
            <RelTime ts={last.ts} />
          </span>
        </span>
      ) : (
        <span className="t-footnote">Nothing sent since the console started</span>
      )}
      {last?.problem ? <span className="t-footnote">{last.problem.cause}</span> : null}
      {pending > 0 ? (
        <span className="t-footnote">
          {pending} waiting{retry_at ? `, next try at ${formatClock(retry_at)}` : ''}
        </span>
      ) : null}
    </div>
  );
}

/** The [[notify]] channels from console.toml: where alerts go, how the last delivery went, and a test button.
 *  Channels are edited in the file, never here, because their URLs are credentials. */
export function NotifyChannels() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [testing, setTesting] = useState<string | null>(null);
  const [tested, setTested] = useState<Tested | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = (first: boolean) =>
      api.notifyChannels().then(
        (rows) => {
          if (!cancelled) setLoad({ status: 'ready', rows });
        },
        (e: unknown) => {
          // A failed poll keeps the rows already shown.
          if (!cancelled && first) setLoad({ status: 'error', problem: problemOf(e, 'load the notification channels') });
        },
      );
    void refresh(true);
    const timer = setInterval(() => { void refresh(false); }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [attempt]);

  const sendTest = async (name: string) => {
    setTesting(name);
    setTested(null);
    try {
      const row = await api.testNotify(name);
      setLoad((l) => (l.status === 'ready' ? { status: 'ready', rows: l.rows.map((r) => (r.name === row.name ? row : r)) } : l));
      setTested({ name, problem: row.last?.ok ? null : (row.last?.problem ?? null) });
    } catch (e) {
      setTested({ name, problem: problemOf(e, 'send the test') });
    } finally {
      setTesting(null);
    }
  };

  const columns: Column<NotifyChannelStatus>[] = [
    {
      id: 'channel',
      header: 'Channel',
      render: (r) => (
        <div className="notify-channel">
          <span className="notify-channel__name">{r.name}</span>
          <span className="t-footnote">{KIND_LABEL[r.kind]}</span>
        </div>
      ),
    },
    { id: 'host', header: 'Host', render: (r) => <span className="notify-host">{r.host}</span> },
    { id: 'sends', header: 'Sends', render: (r) => `${SENDS[r.min_severity]}${r.send_resolved ? ', and recoveries' : ''}` },
    { id: 'last', header: 'Last delivery', render: (r) => <LastDelivery row={r} /> },
    {
      id: 'test',
      header: 'Test',
      align: 'end',
      render: (r) => (
        <Button size="sm" icon={<Send />} disabled={testing !== null} aria-label={`Send test to ${r.name}`} onClick={() => { void sendTest(r.name); }}>
          {testing === r.name ? 'Sending…' : 'Send test'}
        </Button>
      ),
    },
  ];

  const ready = load.status === 'ready';
  return (
    <Panel
      className="alerts-notify"
      title="Notifications"
      subtitle="Where alerts and recoveries are sent when no browser is open. Channels are set in console.toml."
      flush={ready && load.rows.length > 0}
      busy={load.status === 'loading'}
    >
      {load.status === 'loading' ? (
        <RowsSkeleton rows={2} />
      ) : load.status === 'error' ? (
        <ProblemState compact message={load.problem.message} cause={load.problem.cause} fix={load.problem.fix} onRetry={() => { setLoad({ status: 'loading' }); setAttempt((n) => n + 1); }} />
      ) : load.rows.length === 0 ? (
        <EmptyState compact icon={BellOff} title="No notification channels">
          <p>
            Add a <code>[[notify]]</code> table to <code>/etc/sparkline/console.toml</code> and restart the console. The README section
            &ldquo;Notifications&rdquo; describes each kind.
          </p>
          <pre className="notify-snippet">
            <code>{SNIPPET}</code>
          </pre>
        </EmptyState>
      ) : (
        <>
          <Table caption="Notification channels" columns={columns} rows={load.rows} rowKey={(r) => r.name} />
          {tested ? (
            <div className="notify-tested">
              {tested.problem ? (
                <ProblemBanner problem={tested.problem} />
              ) : (
                <div role="status">
                  <Banner tone="ok" title={`Test sent to ${tested.name}`} text="The channel accepted it." />
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
