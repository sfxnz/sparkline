import { Search } from 'lucide-react';
import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button } from '../design/components/Button';
import { Panel } from '../design/components/Panel';
import { StatusPill } from '../design/components/StatusPill';
import { Table, type Column } from '../design/components/Table';
import { api, problemOf } from '../lib/api';
import { formatBytes } from '../lib/format';
import type { FitRequest, FitResponse, KvDtype, NodeFit, Problem } from '../lib/types';
import { Banner, ProblemBanner } from './alerts/parts/Banner';
import { NumberField } from './alerts/parts/NumberField';
import { Select } from './alerts/parts/Select';
import { budgetText, EMPTY_DRAFT, filledFrom, foundOf, fromLookup, hasNvidiaUnifiedMemory, KV_DTYPES, maxContextOf, rangeText, SIZE_UNITS, toRequest, VERDICTS, type Draft, type SizeUnit } from './fit/model';
import './fit/fit.css';
import './views.css';

type Lookup = { status: 'idle' } | { status: 'loading' } | { status: 'error'; problem: Problem };
type Run = { status: 'idle' } | { status: 'loading' } | { status: 'error'; problem: Problem } | { status: 'done'; request: FitRequest; response: FitResponse };

export default function Fit() {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [lookup, setLookup] = useState<Lookup>({ status: 'idle' });
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [submitted, setSubmitted] = useState(false);
  const parsed = toRequest(draft);
  const errors = submitted && !parsed.ok ? parsed.errors : {};
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); };
  // A fact the user types is the user's, so it is held with no repo on it and the form stops naming one.
  const typeShape = (patch: Partial<{ layers: string; kvHeads: string; headDim: string }>) => {
    setDraft((d) => ({ ...d, shape: { from: 'hand', layers: d.shape.layers, kvHeads: d.shape.kvHeads, headDim: d.shape.headDim, ...patch } }));
  };
  const typeSize = (patch: Partial<{ size: string; unit: SizeUnit }>) => {
    setDraft((d) => ({ ...d, weights: { ...(d.weights.from === 'hand' ? d.weights : EMPTY_DRAFT.weights), ...patch } }));
  };
  const repo = draft.repo.trim();
  const weights = draft.weights;
  const shape = draft.shape;
  const filled = filledFrom(draft);
  const context = parsed.ok ? parsed.request.context_tokens : null;
  const maxContext = maxContextOf(draft);

  const lookUp = async () => {
    if (!repo || lookup.status === 'loading') return;
    setLookup({ status: 'loading' });
    try {
      const facts = await api.fitLookup(repo);
      setDraft((d) => fromLookup(d, repo, { weights_bytes: facts.weights_bytes, weights_upper_bound: facts.weights_upper_bound, shape: facts }));
      setLookup({ status: 'idle' });
    } catch (e) {
      const found = foundOf(e);
      if (found) setDraft((d) => fromLookup(d, repo, found));
      setLookup({ status: 'error', problem: problemOf(e, 'look up the model') });
    }
  };

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!parsed.ok || run.status === 'loading') return;
    setRun({ status: 'loading' });
    try {
      setRun({ status: 'done', request: parsed.request, response: await api.fitEstimate(parsed.request) });
    } catch (err) {
      setRun({ status: 'error', problem: problemOf(err, 'estimate the fit') });
    }
  };

  return (
    <div className="view view--narrow fit-view">
      <Panel title="Model" subtitle="A model needs its weights plus a KV cache that grows with the context length. Look the model up, or enter its facts by hand.">
        <form className="fit-form" onSubmit={(e) => { void submit(e); }} noValidate>
          <Field id="fit-repo" label="Hugging Face repo" wide hint="Optional. Look up makes the console read this public repo from huggingface.co. Safetensors repos only.">
            <div className="fit-repo">
              <input
                id="fit-repo"
                className="input"
                placeholder="Qwen/Qwen3-8B"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="fit-repo-hint"
                value={draft.repo}
                onChange={(e) => { set({ repo: e.target.value }); }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  void lookUp();
                }}
              />
              <Button icon={<Search />} disabled={!repo || lookup.status === 'loading'} onClick={() => { void lookUp(); }}>
                {lookup.status === 'loading' ? 'Looking up…' : 'Look up'}
              </Button>
            </div>
            <p className="fit-note" role="status">{filled ? `${filled.complete ? 'Filled in' : 'Partly filled in'} from ${filled.repo}.` : null}</p>
          </Field>
          {lookup.status === 'error' ? <div className="fit-wide"><ProblemBanner problem={lookup.problem} /></div> : null}

          {weights.from === 'lookup' ? (
            <Field
              id="fit-weights"
              label="Weights"
              hint={
                weights.upperBound
                  ? "The total of the repo's weight files, which are one set of shards. The lookup could not read the repo's index, because it is too large, so a server may load fewer of these files and never more."
                  : 'The size of the weight files a server loads from this repo, so quantised weights count as they are stored.'
              }
            >
              <div className="fit-weights fit-weights--files">
                <output id="fit-weights" className="num" aria-describedby="fit-weights-hint">{formatBytes(weights.bytes)}</output>
                <Button size="sm" onClick={() => { set({ weights: EMPTY_DRAFT.weights }); }}>Enter a size</Button>
              </div>
            </Field>
          ) : (
            <Field
              id="fit-size"
              label="Weights"
              hint="The total size of the model's weight files, in the unit beside the box. The repo's Files tab on Hugging Face lists each .safetensors file in GB, so switch the unit if you add those up. A parameter count is not a size: for a 16-bit model the count in GB is half of what its files hold, and a quantised model has no fixed ratio."
            >
              <div className="fit-weights">
                <NumberField id="fit-size" describedBy="fit-size-hint" value={weights.size} onChange={(size) => { typeSize({ size }); }} error={errors.size} width="9rem" />
                <Select aria-label="Unit of the size" value={weights.unit} onChange={(e) => { typeSize({ unit: e.target.value as SizeUnit }); }}>
                  {Object.keys(SIZE_UNITS).map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                </Select>
              </div>
            </Field>
          )}
          <Field id="fit-layers" label="Layers" hint="num_hidden_layers in config.json.">
            <NumberField id="fit-layers" describedBy="fit-layers-hint" value={shape.layers} onChange={(layers) => { typeShape({ layers }); }} error={errors.layers} />
          </Field>
          <Field id="fit-kv-heads" label="KV heads" hint="num_key_value_heads, or num_attention_heads when the model has no grouped attention.">
            <NumberField id="fit-kv-heads" describedBy="fit-kv-heads-hint" value={shape.kvHeads} onChange={(kvHeads) => { typeShape({ kvHeads }); }} error={errors.kvHeads} />
          </Field>
          <Field id="fit-head-dim" label="Head size" hint="head_dim, or hidden_size divided by num_attention_heads.">
            <NumberField id="fit-head-dim" describedBy="fit-head-dim-hint" value={shape.headDim} onChange={(headDim) => { typeShape({ headDim }); }} error={errors.headDim} />
          </Field>
          <Field
            id="fit-context"
            label="Context length"
            hint={
              maxContext === null
                ? 'Tokens the server is started with, for example 32768.'
                : context !== null && context > maxContext
                  ? `More than this model supports (${maxContext.toLocaleString('en')} tokens).`
                  : `This model supports up to ${maxContext.toLocaleString('en')} tokens.`
            }
          >
            <NumberField id="fit-context" describedBy="fit-context-hint" unit="tokens" value={draft.context} onChange={(v) => { set({ context: v }); }} error={errors.context} width="11rem" />
          </Field>
          <Field id="fit-kv-dtype" label="KV cache dtype" hint="fp8 halves the KV cache where the server supports it.">
            <Select id="fit-kv-dtype" aria-describedby="fit-kv-dtype-hint" value={draft.kvDtype} onChange={(e) => { set({ kvDtype: e.target.value as KvDtype }); }}>
              {KV_DTYPES.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </Select>
          </Field>
          <div className="fit-wide fit-actions">
            <Button type="submit" variant="primary" disabled={run.status === 'loading'}>
              {run.status === 'loading' ? 'Estimating…' : 'Estimate'}
            </Button>
          </div>
        </form>
      </Panel>

      {run.status === 'error' ? <ProblemBanner problem={run.problem} /> : null}
      {run.status === 'done' ? <Result request={run.request} response={run.response} /> : null}

      <p className="fit-scope t-footnote">
        The total is a range because activations and the compute graph add 10 to 20 % on top of weights and KV cache. Not modelled: GGUF files, sliding-window attention
        layers, a model split across GPUs, the AMD GTT limit and the macOS wired-memory limit.
      </p>
    </div>
  );
}

function Field({ id, label, hint, wide, children }: { id: string; label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`fit-field${wide ? ' fit-wide' : ''}`}>
      <label htmlFor={id} className="fit-field__label">{label}</label>
      {children}
      {hint ? <p id={`${id}-hint`} className="fit-field__hint">{hint}</p> : null}
    </div>
  );
}

const COLUMNS: readonly Column<NodeFit>[] = [
  { id: 'node', header: 'Node', render: (n) => n.node_id },
  {
    id: 'budget',
    header: 'Free for a model',
    render: (n) => {
      const b = budgetText(n.budget);
      return (
        <div className="fit-budget">
          <span className="num">{b.value}</span>
          <span className="fit-budget__detail">{b.detail}</span>
        </div>
      );
    },
  },
  { id: 'verdict', header: 'Verdict', render: (n) => <StatusPill status={VERDICTS[n.verdict].status} label={VERDICTS[n.verdict].label} size="sm" /> },
];

function Result({ request, response }: { request: FitRequest; response: FitResponse }) {
  const { estimate, nodes } = response;
  const what = `${request.facts.repo ?? 'This model'} at ${request.context_tokens.toLocaleString('en')} tokens of context, ${request.kv_dtype} KV cache`;
  return (
    <Panel title="Result" subtitle={`${what}. Free memory is each node's latest sample.`}>
      <dl className="fit-sums">
        <div>
          <dt>Weights</dt>
          <dd className="num">{formatBytes(estimate.weights_bytes)}</dd>
          {request.facts.weights_upper_bound ? <dd className="fit-sums__detail">the total of the repo's weight files, index not read</dd> : null}
        </div>
        <div>
          <dt>KV cache</dt>
          <dd className="num">{formatBytes(estimate.kv_bytes)}</dd>
          <dd className="fit-sums__detail">{formatBytes(estimate.kv_bytes_per_token)} per token</dd>
        </div>
        <div>
          <dt>Needs in total</dt>
          <dd className="num">{rangeText(estimate)}</dd>
          <dd className="fit-sums__detail">with 10 to 20 % for activations</dd>
        </div>
      </dl>
      <Table caption="Whether the model fits on each node" columns={COLUMNS} rows={nodes} rowKey={(n) => n.node_id} empty="This console has no nodes." />
      {hasNvidiaUnifiedMemory(nodes) ? (
        <div className="fit-warning">
          <Banner
            tone="warn"
            title="On a DGX Spark (GB10), vLLM's memory fraction is not a hard cap"
            text="The GPU shares system memory there, and vLLM has gone past `--gpu-memory-utilization` while starting. Read Tight as a likely No on those nodes."
          />
        </div>
      ) : null}
    </Panel>
  );
}
