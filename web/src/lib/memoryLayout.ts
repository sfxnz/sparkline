import { lostGpu } from './capabilities';
import { MEMORY_MODELS, type GpuInfo, type MemoryModel, type NodeInfo } from './types';

/** How a node's memory is laid out, decided once from NodeInfo for every memory screen. */
export interface MemoryLayout {
  /** Some GPU keeps its memory in system RAM, so the RAM breakdown has a GPU segment (and a node with no GPU, as
   *  before GPUs said where their memory lives). */
  sharesRam: boolean;
  /** GPUs with memory of their own (one VRAM bar each), with any lost GPU beside them. */
  dedicated: GpuInfo[];
  /** "Unified memory" when every GPU that answers keeps its memory in system RAM (GB10, Mac, every older agent). */
  name: 'Unified memory' | 'System memory';
}

const isModel = (m: unknown): m is MemoryModel => (MEMORY_MODELS as readonly unknown[]).includes(m);
const modelOf = (g: GpuInfo): MemoryModel => (isModel(g.memory) ? g.memory : 'unified');

export function memoryLayout(info: NodeInfo | null | undefined): MemoryLayout {
  const gpus = info?.gpus ?? [];
  const lost = (g: GpuInfo) => lostGpu(info, g.index) !== null;
  const answering = gpus.filter((g) => !lost(g));
  const unified = answering.every((g) => modelOf(g) === 'unified');
  return {
    sharesRam: !answering.length || answering.some((g) => modelOf(g) !== 'dedicated'),
    dedicated: unified ? [] : gpus.filter((g) => lost(g) || modelOf(g) !== 'unified'),
    name: unified ? 'Unified memory' : 'System memory',
  };
}
