// Configure → review → run. Step one: parameters and nodes, with a live duration estimate. Step two is the
// confirmation: what runs where, for how long, its thermal/power impact and, from live data, what it will compete
// with. Only "Run benchmark" there starts it (the API also refuses a create without confirm: true).
import { ArrowLeft, CircleCheck, Clock, Play, TriangleAlert } from 'lucide-react';
import type { NetIfInfo } from '../../lib/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../design/components/Button';
import { Dialog } from '../../design/components/Dialog';
import { useNow } from '../../design/useNow';
import type { BenchSpec, NodeStatus } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { liveStore } from '../../store/live';
import { Select } from '../alerts/parts/Select';
import { isServing, topGpuProcess, workloadName } from '../overview/model';
import {
  aboutDuration,
  competition,
  defaultParams,
  splitDescription,
  type Competition,
  type LinkTraffic,
  estimateDuration,
  paramText,
  railLabel,
  runnableNodes,
  runSentence,
  toForm,
  validateParams,
  type FormValue,
  type FormValues,
  type ParamValues,
} from './model';
import { ParamField, ParamForm } from './ParamForm';
import { ImpactChips, ProblemTip } from './parts';

interface Props {
  spec: BenchSpec;
  open: boolean;
  onClose: () => void;
  /** Called with the validated request once the user confirms; the caller closes the dialog (it navigates away). */
  onRun: (nodes: string[], params: ParamValues) => void;
  initialParams?: Record<string, unknown>;
  initialNodes?: string[];
}

const RAIL = 'rail';

/** Defaults for the node picker: the previous run's nodes when still runnable, else the first runnable ones. */
function initialPick(spec: BenchSpec, order: readonly string[], prev?: string[]): string[] {
  const ok = runnableNodes(spec, order);
  const kept = (prev ?? []).filter((n) => ok.includes(n));
  if (kept.length >= spec.min_nodes) return kept.slice(0, spec.max_nodes ?? kept.length);
  return ok.slice(0, Math.max(1, spec.min_nodes));
}

export function ConfigureDialog({ spec, open, onClose, onRun, initialParams, initialNodes }: Props) {
  const order = useCluster((s) => s.order);
  const nodeStates = useCluster((s) => s.nodes);
  const known = useMemo(() => {
    const ids = [...order];
    for (const id of Object.keys(spec.availability)) if (!ids.includes(id)) ids.push(id);
    return ids.filter((id) => id in spec.availability);
  }, [order, spec.availability]);
  const [form, setForm] = useState<FormValues>(() => toForm(spec, { ...defaultParams(spec), ...(initialParams as ParamValues | undefined) }));
  const [nodes, setNodes] = useState<string[]>(() => initialPick(spec, known, initialNodes));
  const [touched, setTouched] = useState(false);
  const [step, setStep] = useState<'configure' | 'review'>('configure');
  const backRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [invalidNote, setInvalidNote] = useState('');
  const [focusInvalid, setFocusInvalid] = useState(0);
  // After an invalid "Review & run": focus the first field with an error (rendered by now).
  useEffect(() => {
    if (!focusInvalid) return;
    bodyRef.current?.querySelector<HTMLElement>('[data-invalid] :is(input, select, textarea, button):not(:disabled)')?.focus();
  }, [focusInvalid]);
  // The step's buttons are replaced, so focus moves with the step: Back on review (never straight onto Run),
  // "Review & run" on returning.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    (step === 'review' ? backRef : reviewRef).current?.focus();
  }, [step]);

  const { values, errors } = validateParams(spec, form);
  // Estimate from whatever is valid so far: a half-typed number keeps its default's contribution.
  const partial = useMemo(() => {
    const d = defaultParams(spec);
    return Object.fromEntries(spec.params.map((p) => [p.name, validateParams({ ...spec, params: [p] }, { [p.name]: form[p.name] ?? '' }).values?.[p.name] ?? d[p.name]])) as ParamValues;
  }, [spec, form]);
  const estimate = estimateDuration(spec, values ?? partial);

  const pair = spec.min_nodes === 2 && spec.max_nodes === 2;
  const maxNodes = spec.max_nodes ?? Infinity;
  const nodeError =
    nodes.length < spec.min_nodes
      ? pair ? 'Choose two different nodes' : `Choose at least ${spec.min_nodes} ${spec.min_nodes === 1 ? 'node' : 'nodes'}`
      : nodes.length > maxNodes ? `Choose at most ${maxNodes}` : pair && nodes[0] === nodes[1] ? 'Choose two different nodes' : null;
  const valid = !!values && !nodeError;
  const shownErrors = touched ? errors : Object.fromEntries(Object.entries(errors).filter(([k]) => typeof form[k] !== 'string' || form[k] !== ''));

  const set = (name: string, v: FormValue) => { setForm((f) => ({ ...f, [name]: v })); };

  const review = () => {
    setTouched(true);
    if (valid) {
      setInvalidNote('');
      setStep('review');
      return;
    }
    const n = Object.keys(errors).length + (nodeError ? 1 : 0);
    setInvalidNote(`Fix ${n} ${n === 1 ? 'field' : 'fields'} to continue.`);
    setFocusInvalid((k) => k + 1);
  };

  const close = () => {
    setStep('configure');
    onClose();
  };

  const railParam = spec.params.find((p) => p.name === RAIL);
  const title = step === 'configure' ? `Configure ${spec.name}` : `Run ${spec.name}?`;
  const about = splitDescription(spec.description);

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      size="md"
      className="bench-config"
      initialFocus={step === 'review' ? backRef : undefined}
      description={step === 'configure' ? about.summary : undefined}
      footer={
        step === 'configure' ? (
          <>
            <span className="bench-config__estimate" aria-live="polite">
              <Clock aria-hidden="true" />
              <span>
                Estimated <strong className="num">{aboutDuration(estimate)}</strong>
              </span>
            </span>
            <span className="visually-hidden" role="status">{invalidNote}</span>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button ref={reviewRef} variant="primary" onClick={review} aria-disabled={!valid || undefined} className={!valid ? 'is-soft-disabled' : undefined}>
              Review &amp; run…
            </Button>
          </>
        ) : (
          <>
            <Button ref={backRef} variant="ghost" icon={<ArrowLeft />} onClick={() => { setStep('configure'); }} className="bench-config__back">Back</Button>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button variant="primary" icon={<Play />} onClick={() => { if (values) onRun(nodes, values); }}>Run benchmark</Button>
          </>
        )
      }
    >
      {step === 'configure' ? (
        <div className="bench-config__body" ref={bodyRef}>
          {about.method ? (
            <details className="bench-config__method">
              <summary>How it is measured</summary>
              <p>{about.method}</p>
            </details>
          ) : null}
          <section className="bench-config__section" aria-labelledby="bench-nodes-h" data-invalid={nodeError && touched ? true : undefined}>
            <h3 id="bench-nodes-h" className="bench-config__h">{pair ? 'Nodes' : spec.max_nodes === 1 ? 'Node' : 'Nodes'}</h3>
            {pair ? (
              <PairPicker spec={spec} known={known} statuses={nodeStates} nodes={nodes} onChange={setNodes} />
            ) : (
              <NodeList spec={spec} known={known} statuses={nodeStates} nodes={nodes} single={spec.max_nodes === 1} onChange={setNodes} />
            )}
            {pair && railParam ? (
              <ParamField param={railParam} value={form[RAIL]} error={shownErrors[RAIL]} onChange={(v) => { set(RAIL, v); }} />
            ) : null}
            {nodeError && (touched || nodes.length > 0) ? <p className="ops-error" role="alert">{nodeError}</p> : null}
          </section>
          {spec.params.some((p) => !(pair && p.name === RAIL)) ? (
            <section className="bench-config__section" aria-labelledby="bench-params-h">
              <h3 id="bench-params-h" className="bench-config__h">Parameters</h3>
              <ParamForm params={spec.params} values={form} errors={shownErrors} onChange={set} skip={pair ? [RAIL] : []} />
            </section>
          ) : null}
        </div>
      ) : (
        <Review spec={spec} nodes={nodes} values={values ?? {}} estimate={estimate} />
      )}
    </Dialog>
  );
}

function nodeHint(status: NodeStatus | undefined): string {
  return status === 'online' || status === undefined ? '' : status === 'stale' ? 'not reporting' : status;
}

function NodeList({ spec, known, statuses, nodes, single, onChange }: { spec: BenchSpec; known: readonly string[]; statuses: Record<string, { status: NodeStatus } | undefined>; nodes: string[]; single: boolean; onChange: (n: string[]) => void }) {
  return (
    // A group of options, not a list: <li> under role="group" is an axe "listitem" violation.
    <div className="bench-nodes" role={single ? 'radiogroup' : 'group'} aria-label="Nodes to run on">
      {known.map((id) => {
        const problem = spec.availability[id];
        const checked = nodes.includes(id);
        return (
          <div key={id}>
            <label className={`bench-node${problem ? ' is-disabled' : ''}${checked ? ' is-checked' : ''}`}>
              <input
                type={single ? 'radio' : 'checkbox'}
                name={single ? `bench-node-${spec.id}` : undefined}
                checked={checked}
                disabled={!!problem}
                onChange={(e) => {
                  if (single) onChange([id]);
                  else onChange(e.target.checked ? known.filter((n) => n === id || nodes.includes(n)) : nodes.filter((n) => n !== id));
                }}
              />
              <span className="bench-node__name">{id}</span>
              {problem ? (
                <span className="bench-node__why"><ProblemTip problem={problem} /></span>
              ) : (
                <NodeLoad node={id} hint={nodeHint(statuses[id]?.status)} />
              )}
            </label>
          </div>
        );
      })}
    </div>
  );
}

function PairPicker({ spec, known, statuses, nodes, onChange }: { spec: BenchSpec; known: readonly string[]; statuses: Record<string, { status: NodeStatus } | undefined>; nodes: string[]; onChange: (n: string[]) => void }) {
  const roles = ['Source', 'Target'] as const;
  return (
    <div className="bench-pair">
      {roles.map((role, i) => (
        <div key={role} className="bench-field">
          <label className="bench-field__label" htmlFor={`bench-${role}`}>{role}</label>
          <Select
            id={`bench-${role}`}
            value={nodes[i] ?? ''}
            onChange={(e) => {
              const next = [...nodes];
              next[i] = e.target.value;
              // Picking the other side's node swaps them, so the pair stays two different nodes.
              if (next[1 - i] === e.target.value) next[1 - i] = nodes[i] ?? '';
              onChange(next.filter(Boolean));
            }}
          >
            {known.map((id) => {
              const problem = spec.availability[id];
              const hint = problem ? ` — ${problem.message}` : nodeHint(statuses[id]?.status) ? ` — ${nodeHint(statuses[id]?.status)}` : '';
              return <option key={id} value={id} disabled={!!problem}>{id}{hint}</option>;
            })}
          </Select>
        </div>
      ))}
    </div>
  );
}

/** Live one-liner next to a node: "96% GPU · serving DeepSeek…" (refreshes every 2 s while the dialog is open). */
function NodeLoad({ node, hint }: { node: string; hint: string }) {
  useNow(2000);
  const s = liveStore.latest(node);
  const util = s?.gpu[0]?.util;
  const top = topGpuProcess(s?.procs);
  const text = [hint, top ? `${isServing(top) ? 'serving' : 'running'} ${workloadName(top)}` : null, util != null ? `GPU ${Math.round(util)}%` : null].filter(Boolean).join(' · ');
  return <span className="bench-node__load num">{text || 'No live data'}</span>;
}

const TRAFFIC_WINDOW_S = 60;

/** Each rail's peak receive/transmit over the last minute of live samples (bursty TP=2 traffic is not missed). */
function recentTraffic(node: string, rails: readonly NetIfInfo[]): LinkTraffic[] {
  const last = liveStore.lastTs(node);
  if (last === null) return [];
  const keys = rails.flatMap((r) => [`net.${r.name}.rx_bps`, `net.${r.name}.tx_bps`]);
  const w = liveStore.window(node, keys, last - TRAFFIC_WINDOW_S);
  const peak = (i: number) => Math.max(0, ...(w.values[i] ?? []).filter((v): v is number => v != null));
  return rails.map((r, i) => ({ name: r.name, label: railLabel(r), rx: peak(2 * i), tx: peak(2 * i + 1) }));
}

function Review({ spec, nodes, values, estimate }: { spec: BenchSpec; nodes: string[]; values: ParamValues; estimate: number }) {
  useNow(1000); // live: what it competes with is re-read every second
  const infos = useCluster((s) => s.nodes);
  const live = competition(spec, nodes, (n) => liveStore.latest(n), (n) => (infos[n]?.info?.net ?? []).filter((x) => x.role === 'interconnect'), recentTraffic);
  // Once a node has been shown busy it stays busy while the review is open: the verdict must not flip while it is read.
  const [seenBusy, setSeenBusy] = useState<Record<string, Competition>>({});
  const fresh = live.filter((c) => c.busy && seenBusy[c.node]?.text !== c.text);
  if (fresh.length) setSeenBusy((s) => ({ ...s, ...Object.fromEntries(fresh.map((c) => [c.node, c])) }));
  const comp = live.map((c) => (c.busy ? c : (seenBusy[c.node] ?? c)));
  const busy = comp.filter((c) => c.busy);
  return (
    <div className="bench-review">
      <p className="bench-review__lead">{runSentence(spec, nodes)}</p>
      <dl className="bench-review__facts">
        <div>
          <dt>Estimated duration</dt>
          <dd className="num">{aboutDuration(estimate)}</dd>
        </div>
        <div>
          <dt>Parameters</dt>
          <dd>
            {spec.params.length
              ? spec.params.map((p) => (
                  <span key={p.name} className="bench-review__param">
                    {p.label} <strong>{paramText(p, values[p.name])}</strong>
                  </span>
                ))
              : 'None'}
          </dd>
        </div>
        <div>
          <dt>Impact</dt>
          <dd>
            <ImpactChips impact={spec.impact} compact />
            {spec.impact.note ? <p className="bench-review__note">{spec.impact.note}</p> : null}
          </dd>
        </div>
      </dl>
      <section className={`bench-review__compete${busy.length ? ' tone-warn is-busy' : ''}`} aria-labelledby="bench-compete-h">
        <h3 id="bench-compete-h" className="bench-config__h">{busy.length ? 'It will compete with running work' : 'Nothing to compete with'}</h3>
        <ul>
          {comp.map((c) => (
            <li key={c.node} className={c.busy ? 'is-busy' : undefined}>
              {c.busy ? <TriangleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="bench-review__cancel">You can cancel at any time; cancelling cleans up containers and temp files.</p>
    </div>
  );
}
