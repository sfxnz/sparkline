import type { Status } from '../../design/components/StatusPill';
import { DASH, formatBytes } from '../../lib/format';
import type { FitEstimate, FitRequest, FitVerdict, KvDtype, ModelFacts, NodeBudget, NodeFit } from '../../lib/types';

/** The safetensors dtypes the console can size: the keys of DTYPE_BYTES in server/sparkline/console/fit.py. */
export const WEIGHT_DTYPES = ['BF16', 'F16', 'F32', 'F64', 'F8_E4M3', 'F8_E5M2', 'I8', 'U8', 'I16', 'I32', 'I64', 'BOOL'] as const;

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

/** The form as typed. Numbers stay text until Estimate, so a half-typed field is not an error yet. */
export interface Draft {
  repo: string;
  weights: { dtype: string; count: string }[];
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
  weights: [{ dtype: 'BF16', count: '' }],
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
    weights: Object.entries(facts.params_by_dtype).map(([dtype, n]) => ({ dtype, count: String(n) })),
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

export type DraftErrors = Partial<Record<'layers' | 'kvHeads' | 'headDim' | 'context' | `count${number}`, string>>;

export function toRequest(draft: Draft): { ok: true; request: FitRequest } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const need = (key: keyof DraftErrors, text: string): number => {
    const n = parseCount(text);
    if (n === null) errors[key] = 'Enter a whole number above 0';
    return n ?? 0;
  };
  const params: Record<string, number> = {};
  draft.weights.forEach((w, i) => { params[w.dtype] = (params[w.dtype] ?? 0) + need(`count${i}`, w.count); });
  const request: FitRequest = {
    facts: {
      repo: draft.source?.repo ?? null,
      params_by_dtype: params,
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

/** How much a node can give a model, and where that number comes from. */
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

/** A GB10 (DGX Spark): NVIDIA GPU on unified memory, where vLLM's memory fraction does not bound it. */
export const hasGb10 = (nodes: readonly NodeFit[]) => nodes.some((n) => n.budget.kind === 'unified' && n.budget.gpu_vendor === 'nvidia');
