import type { Status } from '../../design/components/StatusPill';
import { DASH, formatBytes } from '../../lib/format';
import { ApiError } from '../../lib/api';
import type { FitEstimate, FitRequest, FitVerdict, KvDtype, LookupFailure, ModelFacts, ModelShape, NodeBudget, NodeFit } from '../../lib/types';

/** Bytes in the units a size is typed in: GiB as this page shows sizes, GB as Hugging Face lists a file's size. */
export const SIZE_UNITS = { GiB: 2 ** 30, GB: 1e9 } as const;
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
 * The size of the model's weight files. A size a lookup read carries the repo it was read from, so it cannot
 * exist apart from that repo: nothing holds a `repo` to put beside a size the user typed. A parameter count is
 * not a size: a quantised model keeps some layers at 16 bits, so its files are larger than its count times its
 * bits.
 */
export type DraftWeights = { from: 'lookup'; repo: string; bytes: number; upperBound: boolean } | { from: 'hand'; size: string; unit: SizeUnit };

/** What sizes the KV cache, under the same rule: a shape a lookup read carries its repo, a typed one has none. */
export type DraftShape =
  | { from: 'lookup'; repo: string; layers: string; kvHeads: string; headDim: string; maxContext: number | null }
  | { from: 'hand'; layers: string; kvHeads: string; headDim: string };

export interface Draft {
  repo: string;
  weights: DraftWeights;
  shape: DraftShape;
  context: string;
  kvDtype: KvDtype;
}

export const EMPTY_DRAFT: Draft = {
  repo: '',
  weights: { from: 'hand', size: '', unit: 'GiB' },
  shape: { from: 'hand', layers: '', kvHeads: '', headDim: '' },
  context: '32768',
  kvDtype: 'bf16',
};

/**
 * Fill the form with what a lookup of `repo` read: the whole model, the shape alone, or nothing. Both the
 * size and the shape are replaced by what this lookup read, or by nothing: no value of an earlier lookup and
 * nothing typed before can stay under the new repo's name. A size comes only with the shape it belongs to,
 * because only a full answer holds one. The context length is the user's and is left alone.
 */
export function fromLookup(draft: Draft, repo: string, read: ModelFacts | ModelShape | null): Draft {
  return {
    ...draft,
    weights: read && 'weights_bytes' in read ? { from: 'lookup', repo, bytes: read.weights_bytes, upperBound: read.weights_upper_bound } : EMPTY_DRAFT.weights,
    shape: read
      ? { from: 'lookup', repo, layers: String(read.num_layers), kvHeads: String(read.num_kv_heads), headDim: String(read.head_dim), maxContext: read.max_context }
      : EMPTY_DRAFT.shape,
  };
}

/**
 * The repo each part of the model was read from, or null for a part typed by hand. Each part answers for
 * itself: retyping the shape does not make a size the console read a typed one, and the other way round.
 */
export interface ReadFrom {
  size: string | null;
  shape: string | null;
}

export const readFrom = ({ weights, shape }: Draft): ReadFrom => ({
  size: weights.from === 'lookup' ? weights.repo : null,
  shape: shape.from === 'lookup' ? shape.repo : null,
});

/** The longest context the looked-up model supports, when a lookup read the shape. */
export const maxContextOf = (draft: Draft) => (draft.shape.from === 'lookup' ? draft.shape.maxContext : null);

/**
 * What a lookup the console made and refused still read: its shape, or none. Null when the error is no refusal
 * of a lookup, because none was made: the lookup is turned off, the text is not an id, or the console did not
 * answer. The console answers a lookup it refused with 502 and a problem, and nothing else that way.
 */
export function refusalOf(err: unknown): { shape: ModelShape | null } | null {
  if (!(err instanceof ApiError) || err.status !== 502) return null;
  try {
    const body = JSON.parse(err.body) as Partial<LookupFailure> | null;
    return body?.problem ? { shape: body.shape ?? null } : null;
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
  const typed = w.from === 'hand' ? parseSize(w.size, w.unit) : null;
  if (w.from === 'hand' && typed === null) errors.size = 'Enter a size above 0, for example 9.98';
  const from = readFrom(draft);
  const request: FitRequest = {
    facts: {
      // Both parts come from one lookup when both are a lookup's, because a lookup replaces both.
      repo: from.shape !== null ? from.size : null,
      weights_bytes: w.from === 'lookup' ? w.bytes : (typed ?? 0),
      weights_upper_bound: w.from === 'lookup' && w.upperBound,
      num_layers: need('layers', draft.shape.layers),
      num_kv_heads: need('kvHeads', draft.shape.kvHeads),
      head_dim: need('headDim', draft.shape.headDim),
      max_context: maxContextOf(draft),
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
