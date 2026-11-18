import sample from '../test/fixtures/sample.json';
import { LLM_FIELDS, reading, serverLine, serverTitle } from './llm';
import type { ModelServerSample, Sample } from './types';

const [vllm, down] = (sample as unknown as Sample).llm as [ModelServerSample, ModelServerSample];
const server = (p: Partial<ModelServerSample>): ModelServerSample => ({ ...vllm, ...p });

describe('reading', () => {
  it('gives a field the server sent as a value, zero included', () => {
    expect(reading(vllm, 'running')).toEqual({ kind: 'value', value: 3 });
    expect(reading(vllm, 'waiting')).toEqual({ kind: 'value', value: 0 });
  });

  it('gives a field the server can report and has nothing for now as empty, with the reason', () => {
    expect(reading(vllm, 'ttft_p50_s')).toEqual({ kind: 'empty', why: 'No request finished in the last minute' });
  });

  it('gives a field the server never exports as not reported, naming the server', () => {
    const r = reading(vllm, 'kv_cache_pct');
    expect(r).toMatchObject({ kind: 'unreported', gap: { label: 'Not reported by this server', detail: 'vLLM exports no KV cache usage gauge.' } });
    expect(reading(server({ software: null }), 'kv_cache_pct')).toMatchObject({ gap: { detail: 'This server exports no KV cache usage gauge.' } });
  });

  it('reads memory joined from the process as a value though the server does not report it', () => {
    expect(vllm.reports).not.toContain('mem_bytes');
    expect(reading(vllm, 'mem_bytes')).toEqual({ kind: 'value', value: 21474836480 });
  });

  it('has no reading for a server that is down or loading, whatever it last sent', () => {
    for (const f of LLM_FIELDS) expect(reading(down, f)).toEqual({ kind: 'empty', why: 'No reading from this server' });
    expect(reading(server({ state: 'loading' }), 'running')).toEqual({ kind: 'empty', why: 'The server is still loading its model' });
    expect(reading(server({ state: 'sleeping' }), 'running')).toEqual({ kind: 'value', value: 3 });
  });

  it('never reads a missing value as 0', () => {
    for (const s of [vllm, down, server({ values: {}, reports: [] })]) {
      for (const f of LLM_FIELDS) {
        const r = reading(s, f);
        if (r.kind === 'value') expect(s.values[f]).toBe(r.value);
      }
    }
  });
});

describe('serverTitle', () => {
  it('names the one model, counts several, and falls back to the port', () => {
    expect(serverTitle(vllm)).toBe('Qwen3-32B');
    expect(serverTitle(server({ models: [...vllm.models, ...vllm.models] }))).toBe('2 models');
    expect(serverTitle(down)).toBe('Port 9931');
  });
});

describe('serverLine', () => {
  it('lists the readings a ready server has and leaves out the ones it has not', () => {
    expect(serverLine(vllm)).toBe('3 running · 0 waiting · 212 tok/s');
    expect(serverLine(server({ values: { up: 1, gen_tps: 41.26 } }))).toBe('41.3 tok/s');
    expect(serverLine(server({ values: { up: 1 } }))).toBe('Ready');
  });

  it('says the state of a server that is not serving', () => {
    expect(serverLine(down)).toBe('Down');
    expect(serverLine(server({ state: 'sleeping' }))).toBe('Asleep');
    expect(serverLine(server({ state: 'loading' }))).toBe('Loading');
  });
});
