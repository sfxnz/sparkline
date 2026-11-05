import gb10Info from '../test/fixtures/platforms/gb10/info.json';
import wsInfo from '../test/fixtures/platforms/workstation/info.json';
import { gpuAt } from './gpu';
import { memoryLayout } from './memoryLayout';
import type { GpuInfo, MemoryModel, NodeInfo } from './types';

const gb10 = gb10Info as unknown as NodeInfo;
const ws1 = wsInfo as unknown as NodeInfo;
const LOST = 'NVML could not open GPU 2 (NVML: GPU is lost)';
const withModels = (info: NodeInfo, models: (MemoryModel | undefined)[], lost: number[] = []): NodeInfo => ({
  ...info,
  gpus: models.map((memory, index) => ({ ...(gpuAt(info.gpus, 0) as GpuInfo), index, memory })),
  unsupported: [...info.unsupported, ...lost.map((i) => ({ metric: `gpu${i}`, reason: LOST, kind: 'hardware' as const }))],
});
const indexes = (info: NodeInfo) => memoryLayout(info).dedicated.map((g) => g.index);

describe('memoryLayout', () => {
  it('reads a GB10 as unified memory with the GPU inside RAM, as before', () => {
    expect(memoryLayout(withModels(gb10, ['unified']))).toEqual({ sharesRam: true, dedicated: [], name: 'Unified memory' });
  });

  it('reads an older agent, which sends no memory model, as unified', () => {
    const dropModel = (g: GpuInfo) => Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'memory' && k !== 'vram_total')) as unknown as GpuInfo;
    const old = { ...gb10, gpus: gb10.gpus.map(dropModel) };
    expect(old.gpus.every((g) => !('memory' in g))).toBe(true);
    expect(memoryLayout(old)).toEqual({ sharesRam: true, dedicated: [], name: 'Unified memory' });
  });

  it('reads a memory model it does not know as unified', () => {
    expect(memoryLayout(withModels(gb10, ['hbm' as MemoryModel])).name).toBe('Unified memory');
  });

  it('keeps unified memory for a node with no GPU, or before its info arrives', () => {
    expect(memoryLayout({ ...gb10, gpus: [] })).toEqual({ sharesRam: true, dedicated: [], name: 'Unified memory' });
    expect(memoryLayout(null)).toEqual({ sharesRam: true, dedicated: [], name: 'Unified memory' });
  });

  it('reads a discrete workstation as system memory with no GPU in RAM, and a VRAM bar per GPU', () => {
    const layout = memoryLayout(withModels(ws1, ['dedicated', 'dedicated', 'dedicated', 'dedicated']));
    expect(layout.name).toBe('System memory');
    expect(layout.sharesRam).toBe(false);
    expect(layout.dedicated.map((g) => g.index)).toEqual([0, 1, 2, 3]);
  });

  it('lets the GPUs that answer decide, and keeps a lost GPU among the VRAM bars', () => {
    const info = withModels(ws1, ['dedicated', 'dedicated', undefined, 'dedicated'], [2]);
    expect(memoryLayout(info)).toMatchObject({ sharesRam: false, name: 'System memory' });
    expect(indexes(info)).toEqual([0, 1, 2, 3]);
  });

  it('stays unified when the only GPU is lost, with no VRAM bar for it', () => {
    expect(memoryLayout(withModels(gb10, [undefined], [0]))).toEqual({ sharesRam: true, dedicated: [], name: 'Unified memory' });
  });

  it('reads a carve-out as system memory that still holds GPU memory, with a bar for the carve-out', () => {
    const info = withModels(gb10, ['carveout']);
    expect(memoryLayout(info)).toMatchObject({ sharesRam: true, name: 'System memory' });
    expect(indexes(info)).toEqual([0]);
  });

  it('reads a unified iGPU beside a dedicated GPU as system memory with the iGPU in RAM', () => {
    const info = withModels(gb10, ['unified', 'dedicated']);
    expect(memoryLayout(info)).toMatchObject({ sharesRam: true, name: 'System memory' });
    expect(indexes(info)).toEqual([1]);
  });
});
