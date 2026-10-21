// Every finished scenario in a sortable table, filtered by result and searched by text; a row opens the scenario
// dialog: what it checks, upstream's pass and fail criteria, the evaluator's verdict, the tool calls made, latency
// per turn, tokens and the trace. Model-produced text (summaries, notes, tool calls, traces) is always plain text.
import { CircleCheck, CircleX, Search, ShieldAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Dialog } from '../../../design/components/Dialog';
import { Panel } from '../../../design/components/Panel';
import { Table, type Column } from '../../../design/components/Table';
import { Select } from '../../alerts/parts/Select';
import {
  failureKindText,
  filterRecords,
  formatMs,
  formatSeconds,
  formatTokens,
  noCallsText,
  OUTCOMES,
  scenarioNumber,
  scenarios,
  toolCallList,
  type Filter,
  type Outcome,
  type ScenarioRecord,
} from './model';
import { CategoryTag, DifficultyDots, VerdictPill } from './parts';

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All results' },
  { value: 'fail', label: 'Failed' },
  { value: 'partial', label: 'Partial' },
  { value: 'pass', label: 'Passed' },
  { value: 'excluded', label: 'Excluded' },
];

/** Worst first when sorting by result. */
const RESULT_ORDER: Record<Outcome, number> = { fail: 0, partial: 1, excluded: 2, pass: 3 };

export function ScenariosPanel({ records, total, incomplete, onOpen }: { records: readonly ScenarioRecord[]; total: number; incomplete?: boolean; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const rows = useMemo(() => filterRecords(records, filter, query), [records, filter, query]);
  const counts = useMemo(() => Object.fromEntries(OUTCOMES.map((o) => [o, records.filter((r) => r.outcome === o).length])) as Record<Outcome, number>, [records]);
  const columns = useMemo<Column<ScenarioRecord>[]>(
    () => [
      { id: 'id', header: 'ID', sortValue: (r) => scenarioNumber(r.id), render: (r) => <span className="te-id num">{r.id}</span> },
      {
        id: 'title',
        header: 'Scenario',
        sortValue: (r) => r.title,
        render: (r) => (
          <button type="button" className="te-open" onClick={() => { onOpen(r.id); }}>
            {r.title || r.id}
          </button>
        ),
      },
      {
        id: 'cat',
        header: 'Category',
        sortValue: (r) => r.category,
        render: (r) => (
          <span className="te-catcell te-nowrap">
            <CategoryTag cat={r.category} />
            <span className="t-secondary">{r.categoryLabel}</span>
          </span>
        ),
      },
      { id: 'difficulty', header: 'Difficulty', sortValue: (r) => r.difficulty, render: (r) => <DifficultyDots value={r.difficulty} /> },
      { id: 'result', header: 'Result', sortValue: (r) => RESULT_ORDER[r.outcome], render: (r) => <VerdictPill outcome={r.outcome} /> },
      { id: 'points', header: 'Points', align: 'end', sortValue: (r) => (r.outcome === 'excluded' ? null : r.points), render: (r) => (r.outcome === 'excluded' || r.points === null ? <span className="t-tertiary">—</span> : r.points) },
      { id: 'time', header: 'Time', align: 'end', sortValue: (r) => r.durationS, render: (r) => formatSeconds(r.durationS) },
      { id: 'turns', header: 'Turns', align: 'end', sortValue: (r) => r.turns, render: (r) => r.turns ?? '—' },
      { id: 'kind', header: 'Failure kind', sortValue: (r) => failureKindText(r.failureKind) || null, render: (r) => <span className="t-secondary">{failureKindText(r.failureKind) || '—'}</span> },
    ],
    [onOpen],
  );
  const shown = rows.length === records.length ? scenarios(records.length) : `${rows.length} of ${scenarios(records.length)}`;
  return (
    <Panel
      title="Scenarios"
      subtitle={incomplete ? `${shown} finished of ${total} · select one for its criteria, tool calls and trace` : `${shown} · select one for its criteria, tool calls and trace`}
      flush
      className="te-scen"
      actions={
        <div className="te-filters">
          <Select size="sm" aria-label="Filter by result" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); }}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} ({f.value === 'all' ? records.length : counts[f.value]})
              </option>
            ))}
          </Select>
          <label className="te-search">
            <Search aria-hidden="true" />
            <input type="search" className="input" placeholder="Search" aria-label="Search scenarios" value={query} onChange={(e) => { setQuery(e.target.value); }} />
          </label>
        </div>
      }
    >
      <Table caption="Scenario results" columns={columns} rows={rows} rowKey={(r) => r.id} initialSort={{ id: 'id', dir: 'asc' }} maxHeight="36rem" empty="No scenario matches this filter and search." />
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ dialog

export function ScenarioDialog({ record, onClose }: { record: ScenarioRecord | null; onClose: () => void }) {
  return (
    <Dialog
      open={record !== null}
      onClose={onClose}
      title={record ? `${record.id} · ${record.title || 'Scenario'}` : 'Scenario'}
      size="lg"
      className="te-dialog"
      description={record ? <DialogMeta r={record} /> : undefined}
    >
      {record ? <DialogBody r={record} /> : null}
    </Dialog>
  );
}

function DialogMeta({ r }: { r: ScenarioRecord }) {
  return (
    <span className="te-dmeta">
      <VerdictPill outcome={r.outcome} size="md" />
      {r.outcome === 'excluded' ? <span>Not graded</span> : r.points === null ? null : <span className="num">{r.points} of 2 points</span>}
      {r.failureKind ? <span>{failureKindText(r.failureKind)}</span> : null}
      <span className="te-catcell">
        <CategoryTag cat={r.category} />
        {r.categoryLabel}
      </span>
      <DifficultyDots value={r.difficulty} />
    </span>
  );
}

function DialogBody({ r }: { r: ScenarioRecord }) {
  const tokens = r.promptTokens === null && r.completionTokens === null ? null : (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
  const calls = toolCallList(r.toolCalls);
  return (
    <div className="te-dlg">
      {r.safetyViolation ? (
        <div className="ops-banner tone-crit">
          <ShieldAlert aria-hidden="true" />
          <div>
            <p className="ops-banner__title">Safety violation</p>
            <p className="ops-banner__text">{r.safetyViolation === r.summary ? 'It counts against the safety gate and can cap the rating.' : r.safetyViolation}</p>
          </div>
          <span />
        </div>
      ) : null}

      <section className="te-dlg__sec">
        <h3 className="te-dlg__h">What it checks</h3>
        <p className="te-dlg__lead">{r.expected || '—'}</p>
        {r.successCase || r.failureCase ? (
          <ul className="te-criteria" aria-label="Upstream’s pass and fail criteria">
            {r.successCase ? (
              <li className="tone-ok">
                <CircleCheck aria-hidden="true" />
                {r.successCase}
              </li>
            ) : null}
            {r.failureCase ? (
              <li className="tone-crit">
                <CircleX aria-hidden="true" />
                {r.failureCase}
              </li>
            ) : null}
          </ul>
        ) : null}
      </section>

      <section className="te-dlg__sec">
        <h3 className="te-dlg__h">Evaluator’s verdict</h3>
        <p className="te-dlg__summary">{r.summary || '—'}</p>
        {r.note ? (
          <p className="te-dlg__note">
            <span className="t-secondary">Note: </span>
            {r.note}
          </p>
        ) : null}
      </section>

      <section className="te-dlg__sec">
        <h3 className="te-dlg__h">Tool calls{calls.shown.length + calls.more ? ` · ${calls.shown.length + calls.more}` : ''}</h3>
        {calls.shown.length ? (
          <ol className="te-calls">
            {calls.shown.map((c, i) => <li key={`${i}:${c}`}><code>{c}</code></li>)}
          </ol>
        ) : (
          <p className="t-secondary te-dlg__none">{noCallsText(r)}</p>
        )}
        {calls.more ? <p className="t-secondary te-dlg__none">{calls.more} more {calls.more === 1 ? 'call isn’t' : 'calls aren’t'} listed.</p> : null}
      </section>

      <section className="te-dlg__sec">
        <h3 className="te-dlg__h">Timing and tokens</h3>
        <dl className="te-facts">
          <div><dt>Duration</dt><dd className="num">{formatSeconds(r.durationS)}</dd></div>
          <div><dt>First token</dt><dd className="num">{formatMs(r.ttftMs)}</dd></div>
          <div><dt>Turns</dt><dd className="num">{r.turns ?? '—'}{r.budgetExceeded ? ' (over budget)' : ''}</dd></div>
          <div>
            <dt>Tokens</dt>
            <dd className="num">{tokens === null ? '—' : formatTokens(tokens)}</dd>
            {r.promptTokens !== null && r.completionTokens !== null ? <dd className="te-facts__foot num">{formatTokens(r.promptTokens)} in · {formatTokens(r.completionTokens)} out</dd> : null}
          </div>
        </dl>
        {r.turnMs.length ? <TurnBars ms={r.turnMs} /> : null}
      </section>

      {r.trace ? (
        <section className="te-dlg__sec">
          <h3 className="te-dlg__h">Trace</h3>
          {/* Focusable so keyboard users can scroll it. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre className="te-trace" tabIndex={0} role="region" aria-label={`Trace of ${r.id}`}>
            {r.trace}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

/** Latency of each model turn as a bar with its value at the tip. */
function TurnBars({ ms }: { ms: readonly number[] }) {
  const max = Math.max(1, ...ms);
  return (
    <figure className="te-turns">
      <figcaption className="te-turns__cap">Latency per turn</figcaption>
      <ol className="te-turns__list">
        {ms.map((v, i) => (
          <li key={i}>
            <span className="te-turns__label">Turn {i + 1}</span>
            <span className="te-turns__track" aria-hidden="true">
              <span style={{ width: `${(v / max) * 100}%` }} />
            </span>
            <span className="te-turns__value num">{formatMs(v)}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
