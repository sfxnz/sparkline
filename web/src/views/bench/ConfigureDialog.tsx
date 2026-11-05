// Configure → review → run. Step one: parameters and nodes, with a live duration estimate. Step two is the
// confirmation: what runs where, for how long, its thermal/power impact and, from live data, what it will compete
// with. Only "Run benchmark" there starts it (the API also refuses a create without confirm: true).
import { ArrowLeft, CircleCheck, Clock, ClockFading, Play, TriangleAlert } from 'lucide-react';
import type { NetIfInfo } from '../../lib/types';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../design/components/Button';
import { Dialog } from '../../design/components/Dialog';
import { useNow } from '../../design/useNow';
import type { BenchSpec, NodeStatus } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
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
  estimateOn,
  gpuMemoryHeld,
  gpuOptions,
  gpuPick,
  type GpuIndex,
  paramText,
  notDgxSpark,
  railLabel,
  runnableNodes,
  runSentence,
  toForm,
  unestimated,
  usesGpu,
  validateParams,
  type FormValue,
  type FormValues,
  type ParamValues,
} from './model';
import { ParamField, ParamForm } from './ParamForm';
import { ImpactChips, ProblemTip } from './parts';
import { gpuAt } from '../../lib/gpu';

interface Props {
  spec: BenchSpec;
  open: boolean;
  onClose: () => void;
  /** Called with the validated request once the user confirms; the caller closes the dialog (it navigates away). */
  onRun: (nodes: string[], params: ParamValues, gpuIndex: GpuIndex) => void;
  initialParams?: Record<string, unknown>;
  initialNodes?: string[];
  initialGpuIndex?: GpuIndex;
}

const RAIL = 'rail';

/** Defaults for the node picker: the previous run's nodes when still runnable, else the first runnable ones. */
function initialPick(spec: BenchSpec, order: readonly string[], prev?: string[]): string[] {
  const ok = runnableNodes(spec, order);
  const kept = (prev ?? []).filter((n) => ok.includes(n));
  if (kept.length >= spec.min_nodes) return kept.slice(0, spec.max_nodes ?? kept.length);
  return ok.slice(0, Math.max(1, spec.min_nodes));
}

export function ConfigureDialog({ spec, open, onClose, onRun, initialParams, initialNodes, initialGpuIndex }: Props) {
  const order = useCluster((s) => s.order);
  const nodeStates = useCluster((s) => s.nodes);
  const consoleLive = useConnection((s) => s.status === 'live');
  // While the browser has lost the console every node reads as not reporting, as in the nav (nodeDisplayStatus).
  const statusOf = (n: string): NodeStatus | undefined => {
    const st = nodeStates[n]?.status;
    return st && !consoleLive ? 'stale' : st;
  };
  const known = useMemo(() => {
    const ids = [...order];
    for (const id of Object.keys(spec.availability)) if (!ids.includes(id)) ids.push(id);
    return ids.filter((id) => id in spec.availability);
  }, [order, spec.availability]);
  const [form, setForm] = useState<FormValues>(() => toForm(spec, { ...defaultParams(spec), ...(initialParams as ParamValues | undefined) }));
  const [nodes, setNodes] = useState<string[]>(() => initialPick(spec, known, initialNodes));
  const [gpuChoice, setGpuChoice] = useState<GpuIndex>(() => initialGpuIndex ?? {});
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
  const estimate = estimateOn(spec, nodes, values ?? partial);
  const unknownOn = unestimated(spec, nodes);
  const gpuOn = usesGpu(spec, values ?? partial);
  const gpuIndex = gpuOn ? gpuPick(spec, nodes, gpuChoice) : {};

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
              {estimate === null ? <span className="bench-config__estimate-why">{notDgxSpark(unknownOn)}</span> : null}
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
            <Button variant="primary" icon={<Play />} onClick={() => { if (values) onRun(nodes, values, gpuIndex); }}>Run benchmark</Button>
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
              <PairPicker spec={spec} known={known} statusOf={statusOf} nodes={nodes} onChange={setNodes} />
            ) : (
              <NodeList spec={spec} known={known} statusOf={statusOf} nodes={nodes} gpuIndex={gpuIndex} single={spec.max_nodes === 1} onChange={setNodes} />
            )}
            {nodes.filter((n) => gpuOn && gpuOptions(spec, n).length).map((n) => (
              <GpuPicker key={n} spec={spec} node={n} online={(statusOf(n) ?? 'online') === 'online'} value={gpuIndex[n]} onChange={(i) => { setGpuChoice((c) => ({ ...c, [n]: i })); }} />
            ))}
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
        <Review spec={spec} nodes={nodes} gpuIndex={gpuIndex} gpuOn={gpuOn} values={values ?? {}} estimate={estimate} unknownOn={unknownOn} statusOf={statusOf} />
      )}
    </Dialog>
  );
}

function nodeHint(status: NodeStatus | undefined): string {
  return status === 'online' || status === undefined ? '' : status === 'stale' ? 'not reporting' : status;
}

function NodeList({ spec, known, statusOf, nodes, gpuIndex, single, onChange }: { spec: BenchSpec; known: readonly string[]; statusOf: (n: string) => NodeStatus | undefined; nodes: string[]; gpuIndex: GpuIndex; single: boolean; onChange: (n: string[]) => void }) {
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
                <NodeLoad node={id} hint={nodeHint(statusOf(id))} gpu={gpuIndex[id]} />
              )}
            </label>
          </div>
        );
      })}
    </div>
  );
}

function PairPicker({ spec, known, statusOf, nodes, onChange }: { spec: BenchSpec; known: readonly string[]; statusOf: (n: string) => NodeStatus | undefined; nodes: string[]; onChange: (n: string[]) => void }) {
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
              const hint = problem ? ` — ${problem.message}` : nodeHint(statusOf(id)) ? ` — ${nodeHint(statusOf(id))}` : '';
              return <option key={id} value={id} disabled={!!problem}>{id}{hint}</option>;
            })}
          </Select>
        </div>
      ))}
    </div>
  );
}

/** Live one-liner next to a node: "serving DeepSeek… · GPU 62%", or "GPU 2 at 3%" for the GPU chosen on a node with several
 *  (refreshes every 2 s while the dialog is open). */
function NodeLoad({ node, hint, gpu }: { node: string; hint: string; gpu: number | undefined }) {
  useNow(2000);
  const s = liveStore.latest(node);
  const util = gpuAt(s?.gpu, gpu ?? 0)?.util;
  const top = topGpuProcess(s?.procs);
  const text = [hint, top ? `${isServing(top) ? 'serving' : 'running'} ${workloadName(top)}` : null, util != null ? (gpu === undefined ? `GPU ${Math.round(util)}%` : `GPU\u00a0${gpu}\u00a0at\u00a0${Math.round(util)}%`) : null].filter(Boolean).join(' · ');
  return <span className="bench-node__load num">{text || 'No live data'}</span>;
}

function GpuPicker({ spec, node, online, value, onChange }: { spec: BenchSpec; node: string; online: boolean; value: number | undefined; onChange: (index: number) => void }) {
  useNow(2000);
  const id = useId();
  const s = liveStore.latest(node);
  const options = gpuOptions(spec, node);
  // Said once beside the picker, not in each option: the memory is the node's, not one GPU's (#20).
  const held = gpuMemoryHeld(node, s?.procs, online);
  return (
    <div className="bench-field bench-gpu">
      <label className="bench-field__label" htmlFor={id}>GPU on {node}</label>
      <Select id={id} value={value ?? ''} aria-describedby={held ? `${id}-held` : undefined} onChange={(e) => { onChange(Number(e.target.value)); }}>
        {options.map((o) => {
          const util = gpuAt(s?.gpu, o.index)?.util;
          const text = o.problem ? `GPU ${o.index} — ${o.problem.message}` : [`GPU ${o.index}`, util != null ? `${online ? '' : 'was '}${Math.round(util)}% busy` : null, o.name].filter(Boolean).join(' · ');
          return <option key={o.index} value={o.index} disabled={!!o.problem}>{text}</option>;
        })}
      </Select>
      {held ? (
        <p id={`${id}-held`} className="bench-field__help bench-gpu__held">
          <TriangleAlert aria-hidden="true" />
          <span>{held} Sparkline cannot see which GPUs hold it.</span>
        </p>
      ) : null}
      {options.map((o) => (o.problem ? <p key={o.index} className="bench-field__help"><ProblemTip problem={o.problem} /></p> : null))}
    </div>
  );
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

function Review({ spec, nodes, gpuIndex, gpuOn, values, estimate, unknownOn, statusOf }: { spec: BenchSpec; nodes: string[]; gpuIndex: GpuIndex; gpuOn: boolean; values: ParamValues; estimate: number | null; unknownOn: readonly string[]; statusOf: (n: string) => NodeStatus | undefined }) {
  useNow(1000); // live: what it competes with is re-read every second
  const infos = useCluster((s) => s.nodes);
  const live = competition(spec, nodes, (n) => liveStore.latest(n), (n) => (infos[n]?.info?.net ?? []).filter((x) => x.role === 'interconnect'), recentTraffic, gpuIndex, (n) => statusOf(n) ?? 'online', gpuOn);
  // Once a node has been shown busy it stays busy while the review is open: the verdict must not flip while it is read.
  // A stale reading still replaces it, since a busy verdict from before is no longer live.
  const [seenBusy, setSeenBusy] = useState<Record<string, Competition>>({});
  const fresh = live.filter((c) => c.busy && seenBusy[c.node]?.text !== c.text);
  if (fresh.length) setSeenBusy((s) => ({ ...s, ...Object.fromEntries(fresh.map((c) => [c.node, c])) }));
  const comp = live.map((c) => (c.busy || c.stale ? c : (seenBusy[c.node] ?? c)));
  const busy = comp.filter((c) => c.busy);
  const stale = comp.some((c) => c.stale);
  return (
    <div className="bench-review">
      <p className="bench-review__lead">{runSentence(spec, nodes, gpuIndex)}</p>
      <dl className="bench-review__facts">
        <div>
          <dt>Estimated duration</dt>
          <dd className="num">
            {aboutDuration(estimate)}
            {estimate === null ? <p className="bench-review__note">Sparkline estimates this from DGX Spark rates, and {notDgxSpark(unknownOn)}.</p> : null}
          </dd>
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
      <section className={`bench-review__compete${busy.length ? ' tone-warn is-busy' : stale ? ' tone-stale is-stale' : ''}`} aria-labelledby="bench-compete-h">
        <h3 id="bench-compete-h" className="bench-config__h">{busy.length ? 'It will compete with running work' : stale ? 'Current load unknown' : 'Nothing to compete with'}</h3>
        <ul>
          {comp.map((c) => (
            <li key={c.node} className={c.busy ? 'is-busy' : c.stale ? 'is-stale' : undefined}>
              {c.busy ? <TriangleAlert aria-hidden="true" /> : c.stale ? <ClockFading aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="bench-review__cancel">You can cancel at any time; cancelling cleans up containers and temp files.</p>
    </div>
  );
}
