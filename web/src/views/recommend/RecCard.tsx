// One recommended setting: what it is, what each node says about it (with Apply and Undo where a click can do it),
// what owners claim for it, whether Sparkline measured it, what could go wrong, the commands by hand and the sources.
import { Check, CircleCheck, CircleHelp, CircleSlash, Copy, Lightbulb, MessagesSquare, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../design/components/Button';
import { InlineCode } from '../../design/components/InlineCode';
import { Panel } from '../../design/components/Panel';
import '../../design/components/StatusPill.css';
import { Table, type Column } from '../../design/components/Table';
import { copyText } from '../../lib/clipboard';
import type { NodeRecState, Problem, RecGoal, RecMeasurement, RecMetric, RecState, Recommendation } from '../../lib/types';
import { actionFor, survivesReboot, type NodeRow, type Standing, type Verb } from './model';
import type { RowStatus } from './useRecommendations';

/** Where the evidence files (docs/recommendations/<id>.md) can be read. */
const EVIDENCE_BASE = 'https://github.com/sfxnz/sparkline/blob/main/';
const BY_HAND = 'Apply or undo by hand';

const GOAL: Record<RecGoal, string> = {
  cooler: 'Makes the machine cooler',
  quieter: 'Makes the machine quieter',
  roomier: 'Frees memory',
  faster: 'Makes the machine faster',
};

interface Look {
  label: string;
  icon: LucideIcon;
  tone: string;
}
const STATE: Record<RecState, Look> = {
  'not-applied': { label: 'Recommended', icon: Lightbulb, tone: 'rec-tone-accent' },
  applied: { label: 'Applied', icon: CircleCheck, tone: 'tone-ok' },
  'not-applicable': { label: 'Not applicable', icon: CircleSlash, tone: 'tone-stale' },
  unknown: { label: 'Unknown', icon: CircleHelp, tone: 'tone-stale' },
};
const NO_ANSWER: Look = { label: 'No answer', icon: TriangleAlert, tone: 'tone-warn' };
const FAILED: Record<string, string> = { apply: 'Apply failed', undo: 'Undo failed', reapply: 'Applying it again at boot failed' };
const BUTTON: Record<Verb, { idle: string; pending: string }> = {
  apply: { idle: 'Apply', pending: 'Applying…' },
  undo: { idle: 'Undo', pending: 'Undoing…' },
};

/** State as icon + words in its tone, never colour alone. */
function Pill({ label, icon: Icon, tone }: Look) {
  return (
    <span className={`status status--pill status--sm rec-pill ${tone}`}>
      <Icon className="status__icon" aria-hidden="true" strokeWidth={2.25} />
      <span className="status__label">{label}</span>
    </span>
  );
}

function standingLook(standing: Standing, rows: readonly NodeRow[]): Look {
  if (standing === 'recommended') {
    const n = rows.filter((r) => r.item?.state === 'not-applied').length;
    return { ...STATE['not-applied'], label: `Recommended on ${n} of ${rows.length} ${rows.length === 1 ? 'node' : 'nodes'}` };
  }
  if (standing === 'done') return { ...STATE.applied, label: 'Applied on every node' };
  const unknown = rows.some((r) => !r.item || r.item.state === 'unknown');
  return unknown ? { ...STATE.unknown, label: 'Not known on every node' } : { ...STATE['not-applicable'], label: 'Nothing to apply' };
}

function ProblemLines({ problem, alert }: { problem: Problem; alert?: boolean }) {
  return (
    <div className="rec-problem" role={alert ? 'alert' : undefined}>
      <p className="rec-problem__message">{problem.message}</p>
      {problem.cause ? <p><InlineCode text={problem.cause} /></p> : null}
      {problem.fix ? <p><InlineCode text={problem.fix} /></p> : null}
    </div>
  );
}

type Ask = (node: string, item: NodeRecState, verb: Verb) => void;

function NodeItem({ rec, row, status, onAsk }: { rec: Recommendation; row: NodeRow; status: RowStatus | null; onAsk: Ask }) {
  const item = row.item;
  const pending = status && 'pending' in status ? status.pending : null;
  const verb = pending ?? actionFor(rec, row);
  const text = verb ? BUTTON[verb][pending ? 'pending' : 'idle'] : '';
  // Sparkline would make this change, and this node's helper is missing.
  const noHelper = item && rec.one_click && (item.state === 'not-applied' || (item.state === 'applied' && item.managed)) ? row.helper : null;
  return (
    <li className="rec-node">
      <div className="rec-node__head">
        <span className="rec-node__name">{row.node}</span>
        <Pill {...(item ? STATE[item.state] : NO_ANSWER)} />
      </div>
      <div className="rec-node__body">
        {item ? (
          <>
            <p>{item.detail}</p>
            {item.state === 'applied' && !item.managed ? <p className="rec-node__note">Applied outside Sparkline, so Sparkline does not offer to undo it.</p> : null}
            {item.last && !item.last.ok ? (
              <p className="rec-node__failed tone-crit">
                <TriangleAlert aria-hidden="true" />
                <span>{FAILED[item.last.action] ?? 'The last change failed'}: {item.last.message}</span>
              </p>
            ) : null}
            {noHelper ? (
              <>
                <ProblemLines problem={noHelper} />
                <p className="rec-node__note">The commands are under “{BY_HAND}” below.</p>
              </>
            ) : null}
            {!rec.one_click && item.state === 'not-applied' ? <p className="rec-node__note">Not a one-click setting: follow the steps under “{BY_HAND}” below.</p> : null}
          </>
        ) : (
          <ProblemLines problem={row.problem} />
        )}
        {status && 'problem' in status ? <ProblemLines problem={status.problem} alert /> : null}
      </div>
      {item && verb ? (
        // aria-disabled, not disabled: the button keeps the focus that the closing dialog hands back to it.
        <Button
          className="rec-node__action"
          size="sm"
          variant={verb === 'apply' ? 'primary' : 'secondary'}
          aria-disabled={pending ? true : undefined}
          aria-label={`${text} ${rec.title} on ${row.node}`}
          onClick={() => { if (!pending) onAsk(row.node, item, verb); }}
        >
          {text}
        </Button>
      ) : null}
    </li>
  );
}

const METRIC_COLUMNS: Column<RecMetric>[] = [
  { id: 'metric', header: 'Metric', render: (r) => r.label },
  { id: 'before', header: 'Before', align: 'end', render: (r) => `${r.before} ${r.unit}` },
  { id: 'after', header: 'After', align: 'end', render: (r) => `${r.after} ${r.unit}` },
];

function NewTab() {
  return <span className="visually-hidden"> (opens in a new tab)</span>;
}

function Evidence({ title, measurement: m }: { title: string; measurement: RecMeasurement | null }) {
  if (!m) {
    return (
      <p className="rec-evidence__state">
        <MessagesSquare aria-hidden="true" />
        <span>Not measured by Sparkline yet: community claim</span>
      </p>
    );
  }
  return (
    <div className="rec-evidence">
      <p className="rec-evidence__state tone-ok">
        <CircleCheck aria-hidden="true" />
        <span>Measured on a DGX Spark</span>
      </p>
      <p className="rec-evidence__meta">{m.date} · {m.machine}</p>
      <Table caption={`Measured before and after: ${title}`} columns={METRIC_COLUMNS} rows={m.results} rowKey={(r) => r.label} />
      <p className="rec-evidence__meta">{m.method}</p>
      <p>
        <a href={`${EVIDENCE_BASE}${m.doc}`} target="_blank" rel="noreferrer">Evidence file<NewTab /></a>
      </p>
    </div>
  );
}

function Commands({ label, name, commands }: { label: string; name: string; commands: readonly string[] }) {
  const text = commands.join('\n');
  const [copied, setCopied] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const copy = () => {
    void copyText(text).then((ok) => {
      setCopied(ok);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setCopied(null); }, 2000);
    });
  };
  return (
    <div className="rec-cmd">
      <div className="rec-cmd__head">
        <p className="rec-h">{label}</p>
        <Button size="sm" variant="ghost" icon={copied ? <Check /> : <Copy />} aria-label={`Copy ${name}`} onClick={copy}>
          {copied === null ? 'Copy' : copied ? 'Copied' : 'Not copied'}
        </Button>
        <span className="visually-hidden" role="status">{copied === null ? '' : copied ? 'Copied' : 'The browser blocked the clipboard'}</span>
      </div>
      <pre className="rec-cmd__pre"><code>{text}</code></pre>
    </div>
  );
}

interface Props {
  rec: Recommendation;
  rows: readonly NodeRow[];
  standing: Standing;
  /** What a click is doing on a node's row, by node. */
  statusOf: (node: string) => RowStatus | null;
  onAsk: Ask;
}

export function RecCard({ rec, rows, standing, statusOf, onAsk }: Props) {
  // Open from the start where typing the commands is the only way: not one-click, or a node without the helper.
  const byHandFirst = !rec.one_click || rows.some((r) => r.item && r.item.state === 'not-applied' && r.helper);
  return (
    <Panel className="rec-card" title={rec.title} subtitle={GOAL[rec.goal]} actions={<Pill {...standingLook(standing, rows)} />}>
      <div className="rec-body">
        <p className="rec-summary">{rec.summary}</p>

        {rows.length ? (
          <ul className="rec-nodes" aria-label={`${rec.title}: your nodes`}>
            {rows.map((row) => <NodeItem key={row.node} rec={rec} row={row} status={statusOf(row.node)} onAsk={onAsk} />)}
          </ul>
        ) : (
          <p className="rec-node__note">No nodes are configured yet.</p>
        )}

        <dl className="rec-facts">
          <div>
            <dt className="rec-h">Claimed benefit</dt>
            <dd>{rec.benefit}</dd>
          </div>
          <div>
            <dt className="rec-h">Claimed cost</dt>
            <dd>{rec.cost}</dd>
          </div>
          <div>
            <dt className="rec-h">Survives a reboot</dt>
            <dd>{survivesReboot(rec)}</dd>
          </div>
        </dl>

        <div>
          <h3 className="rec-h">Evidence</h3>
          <Evidence title={rec.title} measurement={rec.measurement} />
        </div>

        <div>
          <h3 className="rec-h">What could go wrong</h3>
          <ul className="rec-list">
            {rec.risks.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>

        <details className="rec-manual" open={byHandFirst}>
          <summary>{BY_HAND}</summary>
          <Commands label="To apply" name={`the commands to apply ${rec.title}`} commands={rec.apply} />
          <Commands label="To undo" name={`the commands to undo ${rec.title}`} commands={rec.undo} />
        </details>

        <div>
          <h3 className="rec-h">Sources</h3>
          <ul className="rec-list">
            {rec.sources.map((s) => (
              <li key={`${s.url} ${s.title}`}>
                <a href={s.url} target="_blank" rel="noreferrer">{s.title}<NewTab /></a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}
