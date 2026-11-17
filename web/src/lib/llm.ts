import type { NotReported } from './capabilities';
import { bytesParts, percentParts, text, type Formatter } from './format';
import type { ModelServerSample, ServerState } from './types';

export const DEFAULT_PORTS = [8000, 8080, 9931, 30000] as const;

export const LLM_FIELDS = ['running', 'waiting', 'gen_tps', 'prompt_tps', 'ttft_p50_s', 'ttft_p95_s', 'kv_cache_pct', 'preempt_per_s', 'mem_bytes'] as const;
export type LlmField = (typeof LLM_FIELDS)[number];

const countParts: Formatter = (n) => ({ value: n.toFixed(0), unit: '' });
const rateParts = (unit: string, digits: number): Formatter => (n) => ({ value: n.toFixed(Math.abs(n) < 100 ? digits : 0), unit });
const secondsParts: Formatter = (s, unit) => (unit === 'ms' || (!unit && Math.abs(s) < 0.9995) ? { value: (s * 1000).toFixed(0), unit: 'ms' } : { value: s.toFixed(2), unit: 's' });

interface FieldSpec {
  label: string;
  format: Formatter;
  empty: string;
  needs: string;
}

const NO_REQUESTS = 'No request finished in the last minute';
const NO_RATE = 'A rate needs two readings: the next one arrives within seconds';
const NO_VALUE = 'Not in the last reading from the server';

export const FIELD_SPECS: Record<LlmField, FieldSpec> = {
  running: { label: 'Requests running', format: countParts, empty: NO_VALUE, needs: 'count of running requests' },
  waiting: { label: 'Requests waiting', format: countParts, empty: NO_VALUE, needs: 'count of queued requests' },
  gen_tps: { label: 'Generation', format: rateParts('tok/s', 1), empty: NO_RATE, needs: 'counter of generated tokens' },
  prompt_tps: { label: 'Prompt', format: rateParts('tok/s', 1), empty: NO_RATE, needs: 'counter of prompt tokens' },
  ttft_p50_s: { label: 'First token, median', format: secondsParts, empty: NO_REQUESTS, needs: 'time-to-first-token histogram' },
  ttft_p95_s: { label: 'First token, p95', format: secondsParts, empty: NO_REQUESTS, needs: 'time-to-first-token histogram' },
  kv_cache_pct: { label: 'KV cache used', format: percentParts, empty: NO_VALUE, needs: 'KV cache usage gauge' },
  preempt_per_s: { label: 'Preemptions', format: rateParts('/s', 2), empty: NO_RATE, needs: 'counter of preempted requests' },
  mem_bytes: { label: 'Memory held', format: bytesParts, empty: NO_VALUE, needs: 'memory gauge, and no GPU process was matched to its port' },
};

const NOT_ANSWERING: Partial<Record<ServerState, string>> = {
  down: 'The server is not answering',
  loading: 'The server is still loading its model',
};

export type Reading = { kind: 'value'; value: number } | { kind: 'empty'; why: string } | { kind: 'unreported'; gap: NotReported };

export function reading(server: ModelServerSample, field: LlmField): Reading {
  const quiet = NOT_ANSWERING[server.state];
  if (quiet) return { kind: 'empty', why: quiet };
  const value = server.values[field];
  if (value !== undefined && Number.isFinite(value)) return { kind: 'value', value };
  if (server.reports.includes(field)) return { kind: 'empty', why: FIELD_SPECS[field].empty };
  const who = server.software ?? 'This server';
  return { kind: 'unreported', gap: { kind: 'hardware', label: 'Not reported by this server', detail: `${who} exports no ${FIELD_SPECS[field].needs}.` } };
}

export function serverTitle(server: ModelServerSample): string {
  const [first, ...rest] = server.models;
  if (!first) return `Port ${String(server.port)}`;
  return rest.length ? `${String(server.models.length)} models` : first.name;
}

export const STATE_LABEL: Record<ServerState, string> = { ready: 'Ready', loading: 'Loading', sleeping: 'Asleep', down: 'Down' };
export const SERVER_PILL = { ready: 'healthy', loading: 'connecting', sleeping: 'stale', down: 'error' } as const satisfies Record<ServerState, string>;

export function serverLine(server: ModelServerSample): string {
  if (server.state !== 'ready') return STATE_LABEL[server.state];
  const parts: string[] = [];
  for (const [field, word] of [['running', ' running'], ['waiting', ' waiting'], ['gen_tps', '']] as const) {
    const r = reading(server, field);
    if (r.kind !== 'value') continue;
    parts.push(`${text(FIELD_SPECS[field].format(r.value))}${word}`);
  }
  return parts.length ? parts.join(' · ') : STATE_LABEL.ready;
}
