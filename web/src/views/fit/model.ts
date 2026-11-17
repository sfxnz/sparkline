import type { Status } from '../../design/components/StatusPill';
import { DASH, formatBytes } from '../../lib/format';
import { ApiError } from '../../lib/api';
import type { FitEstimate, FitRequest, FitVerdict, KvDtype, LookupFound, NodeBudget, NodeFit } from '../../lib/types';

/** Bytes in the units a size is typed in: GB as the Files tab of a Hugging Face repo lists sizes, GiB as this page shows them. */
export const SIZE_UNITS = { GB: 1e9, GiB: 2 ** 30 } as const;
export type SizeUnit = keyof typeof SIZE_UNITS;

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

/**
 * The size of the model's weight files, read by a lookup or typed. A parameter count is not taken: a quantised
 * model keeps some layers at 16 bits, so its files are larger than its count times its bits.
 */
type DraftWeights = { kind: 'files'; bytes: number; upperBound: boolean } | { kind: 'typed'; size: string; unit: SizeUnit };

export interface Draft {
  repo: string;
  weights: DraftWeights;
  layers: string;
  kvHeads: string;
  headDim: string;
  context: string;
  kvDtype: KvDtype;
  /** The lookup the model facts came from, all of them or only a part. Null once a fact is edited or when they were typed by hand. */
  source: { repo: string; maxContext: number | null; complete: boolean } | null;
}

export const EMPTY_DRAFT: Draft = {
  repo: '',
  weights: { kind: 'typed', size: '', unit: 'GB' },
  layers: '',
  kvHeads: '',
  headDim: '',
  context: '32768',
  kvDtype: 'bf16',
  source: null,
};

const EMPTY_SHAPE = { layers: EMPTY_DRAFT.layers, kvHeads: EMPTY_DRAFT.kvHeads, headDim: EMPTY_DRAFT.headDim };

/**
 * Fill the form with what a lookup of `repo` read. The part it could not read is emptied if an earlier lookup
 * filled it, so one repo's size never sits beside another repo's shape. What was typed by hand stays.
 */
export function fromLookup(draft: Draft, repo: string, { weights_bytes: bytes, weights_upper_bound: upperBound, shape }: LookupFound): Draft {
  if (bytes === null && shape === null) return draft;
  return {
    ...draft,
    weights: bytes !== null ? { kind: 'files', bytes, upperBound } : draft.weights.kind === 'files' ? EMPTY_DRAFT.weights : draft.weights,
    ...(shape ? { layers: String(shape.num_layers), kvHeads: String(shape.num_kv_heads), headDim: String(shape.head_dim) } : draft.source ? EMPTY_SHAPE : {}),
    source: { repo, maxContext: shape?.max_context ?? null, complete: bytes !== null && shape !== null },
  };
}

/** What a refused lookup still read, from the body of its error. */
export function foundOf(err: unknown): LookupFound | null {
  if (!(err instanceof ApiError)) return null;
  try {
    return (JSON.parse(err.body) as { found?: LookupFound }).found ?? null;
  } catch {
    return null;
  }
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** A positive whole number, as typed: "8190735360", "8,190,735,360" or the model card's "8.19B". */
export function parseCount(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kmbt])?$/i.exec(text.trim().replace(/[,_]/g, ''));
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (SUFFIX[m[2]?.toLowerCase() ?? ''] ?? 1));
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** A size as typed, in bytes: a plain number above 0 such as "9.98". A unit in the text is refused, so it cannot disagree with the one chosen. */
export function parseSize(text: string, unit: SizeUnit): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const bytes = Math.round(Number(t) * SIZE_UNITS[unit]);
  return bytes > 0 && Number.isSafeInteger(bytes) ? bytes : null;
}

export type DraftErrors = Partial<Record<'layers' | 'kvHeads' | 'headDim' | 'context' | 'size', string>>;

export function toRequest(draft: Draft): { ok: true; request: FitRequest } | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {};
  const need = (key: keyof DraftErrors, text: string): number => {
    const n = parseCount(text);
    if (n === null) errors[key] = 'Enter a whole number above 0';
    return n ?? 0;
  };
  const w = draft.weights;
  const typed = w.kind === 'typed' ? parseSize(w.size, w.unit) : null;
  if (w.kind === 'typed' && typed === null) errors.size = 'Enter a size above 0, for example 9.98';
  const request: FitRequest = {
    facts: {
      repo: draft.source?.complete ? draft.source.repo : null,
      weights_bytes: w.kind === 'files' ? w.bytes : (typed ?? 0),
      weights_upper_bound: w.kind === 'files' && w.upperBound,
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
