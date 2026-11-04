import { describe, expect, it } from 'vitest';
import type { BenchRun } from '../../lib/types';
import { result, run } from './fixtures';
import { CARD_H, drawShareCard } from './ShareCard';

/** A canvas whose 2D context keeps every line of text drawn, measuring text about as wide as the UI font. */
function recorder() {
  const drawn: { text: string; y: number }[] = [];
  const state: Record<string | symbol, unknown> = { font: '' };
  const px = () => Number(/(\d+)px/.exec(String(state.font))?.[1] ?? 10);
  const ctx = new Proxy(state, {
    get: (t, k) => {
      if (k === 'fillText') return (text: string, _x: number, y: number) => drawn.push({ text, y });
      if (k === 'measureText') return (text: string) => ({ width: text.length * px() * 0.5 });
      if (k === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      return k in t ? t[k] : () => undefined;
    },
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { canvas: { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement, drawn };
}

const llm = (node: string, gpu: string, extras: Record<string, unknown>): BenchRun =>
  run({
    id: '0123abcd-run',
    bench_id: 'llm-inference',
    nodes: [node],
    metadata: { nodes: { [node]: { gpu_name: gpu, driver: '580.95.05', cuda: '13.0', ...extras } } },
    results: [result({ metric: 'decode_tok_s', label: 'Decode tokens/s per request', value: 46.5, unit: 'tok/s', node_id: node, extras: { headline: true, ...extras } })],
  });

const NOTE = 'For ws1, figures marked † are modelled on GB10, not measured.';

describe('share card footer', () => {
  it('keeps the environment line beside a modelled note, each whole and on its own line inside the card', () => {
    const { canvas, drawn } = recorder();
    drawShareCard(canvas, llm('ws1', 'NVIDIA RTX 6000 Ada Generation', { modelled_on: 'GB10' }), undefined, 5);
    const env = drawn.find((d) => d.text === 'NVIDIA RTX 6000 Ada Generation  ·  Driver 580.95.05  ·  CUDA 13.0');
    const note = drawn.find((d) => d.text === NOTE);
    expect(env).toBeDefined();
    expect(note).toBeDefined();
    expect(Math.abs((note?.y ?? 0) - (env?.y ?? 0))).toBeGreaterThanOrEqual(16);
    expect(Math.max(note?.y ?? 0, env?.y ?? 0)).toBeLessThanOrEqual(CARD_H - 28);
  });

  it('leaves a measured card with only the environment line, where it always was', () => {
    const { canvas, drawn } = recorder();
    drawShareCard(canvas, llm('spark1', 'NVIDIA GB10', {}), undefined, 5);
    expect(drawn.filter((d) => d.y === 306).map((d) => d.text)).toEqual(['NVIDIA GB10  ·  Driver 580.95.05  ·  CUDA 13.0', 'Run 0123abcd']);
    expect(drawn.some((d) => d.text.includes('modelled') || d.text.includes('†'))).toBe(false);
  });
});
