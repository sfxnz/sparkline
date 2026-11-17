import type { Status } from '../../design/components/StatusPill';
import { DASH, formatBytes } from '../../lib/format';
import type { FitEstimate, FitRequest, FitVerdict, KvDtype, ModelFacts, NodeBudget, NodeFit } from '../../lib/types';

export const WEIGHT_BITS: readonly { value: number; label: string }[] = [
  { value: 32, label: '32-bit (F32)' },
  { value: 16, label: '16-bit (BF16, F16)' },
  { value: 8, label: '8-bit (FP8, INT8)' },
  { value: 4, label: '4-bit (AWQ, GPTQ, bitsandbytes)' },
];

export const KV_DTYPES: readonly { value: KvDtype; label: string }[] = [
  { value: 'bf16', label: 'bf16 (2 bytes)' },
  { value: 'fp16', label: 'fp16 (2 bytes)' },
  { value: 'fp8', label: 'fp8 (1 byte)' },
];

export const VERDICTS: Record<FitVerdict, { status: Status; label: string }> = {
  fits: { status: 'healthy', label: 'Fits' },
  tight: { status: 'warning', label: 'Tight' },
  no: { status: 'critical', label: 'Does not fit' },
  unknown: { status: 'unknown', label: 'Unknown' },
};

/** A lookup knows the size of the repo's weight files. By hand it is a parameter count and the bits each one is stored in. */
type DraftWeights = { kind: 'files'; bytes: number } | { kind: 'params'; count: string; bits: number };

export interface Draft {
  repo: string;
  weights: DraftWeights;
  layers: string;
  kvHeads: string;
  headDim: string;
  context: string;
  kvDtype: KvDtype;
  /** The lookup the model facts came from. Null once a fact is edited or when they were typed by hand. */
  source: { repo: string; maxContext: number | null } | null;
}

export const EMPTY_DRAFT: Draft = {
  repo: '',
  weights: { kind: 'params', count: '', bits: 16 },
  layers: '',
  kvHeads: '',
  headDim: '',
  context: '32768',
  kvDtype: 'bf16',
  source: null,
};

export function fromFacts(draft: Draft, facts: ModelFacts): Draft {
  return {
    ...draft,
    weights: { kind: 'files', bytes: facts.weights_bytes },
    layers: String(facts.num_layers),
    kvHeads: String(facts.num_kv_heads),
    headDim: String(facts.head_dim),
    source: facts.repo ? { repo: facts.repo, maxContext: facts.max_context } : null,
  };
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** A positive whole number, as typed: "8190735360", "8,190,735,360" or the model card's "8.19B". */
export function parseCount(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmbt])?$/i.exec(text.trim().replace(/[,_]/g, ''));
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (SUFFIX[m[2]?.toLowerCase() ?? ''] ?? 1));
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

export type DraftErrors = Partial<Record<'layers' | 'kvHeads' | 'headDim' | 'context' | 'count', string>>;

export function toRequest(draft: Draft): { ok: true; request: FitRequest } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const need = (key: keyof DraftErrors, text: string): number => {
    const n = parseCount(text);
    if (n === null) errors[key] = 'Enter a whole number above 0';
    return n ?? 0;
  };
  const w = draft.weights;
  const request: FitRequest = {
    facts: {
      repo: draft.source?.repo ?? null,
      weights_bytes: w.kind === 'files' ? w.bytes : Math.ceil((need('count', w.count) * w.bits) / 8),
      num_layers: need('layers', draft.layers),
      num_kv_heads: need('kvHeads', draft.kvHeads),
      head_dim: need('headDim', draft.headDim),
      max_context: draft.source?.maxContext ?? null,
    },
    context_tokens: need('context', draft.context),
    kv_dtype: draft.kvDtype,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, request };
}

export const rangeText = (est: FitEstimate) => `${formatBytes(est.total_low)} to ${formatBytes(est.total_high)}`;

export function budgetText(b: NodeBudget): { value: string; detail: string } {
  switch (b.kind) {
    case 'unified':
      return { value: formatBytes(b.bytes), detail: `${formatBytes(b.available)} available, ${formatBytes(b.headroom)} kept free` };
    case 'gpu':
      return { value: formatBytes(b.bytes), detail: `Free on GPU ${b.gpu_index} (${b.gpu_name}). Single-GPU fit` };
    case 'unknown':
      return { value: DASH, detail: b.reason };
  }
}

export const hasNvidiaUnifiedMemory = (nodes: readonly NodeFit[]) => nodes.some((n) => n.budget.kind === 'unified' && n.budget.gpu_vendor === 'nvidia');
