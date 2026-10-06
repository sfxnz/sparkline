import type { GpuInfo, NodeInfo, SensorInfo } from '../../../lib/types';
import { buildGroups, chartSensors, headroom, hottest, minMax, shortLabels, type Reader } from './thermal';

const gpu: GpuInfo = { index: 0, name: 'NVIDIA GB10', uuid: null, arch: null, compute_capability: null, cuda_cores: null, sm_mhz_max: null, temp_slowdown_c: 86, temp_shutdown_c: 90, temp_max_c: 99, power_limit_w: null };
const sensor = (id: string, group: SensorInfo['group'], crit_c: number | null = null): SensorInfo => ({ id, label: id, group, crit_c });
const info = (sensors: SensorInfo[]) => ({ gpus: [gpu], sensors, unsupported: [] }) as unknown as NodeInfo;
/** Reader over hwmon readings by sensor id, plus the GPU. */
const sample = (temps: Record<string, number | null>, gpuC: number | null = 70): Reader => (key) =>
  key === 'gpu0.temp_c' ? gpuC : (temps[key.slice('temp.'.length)] ?? null);
const none: Reader = () => null;

describe('buildGroups', () => {
  it('orders GPU, SoC, NVMe, NIC, other; folds wireless into other; drops empty groups', () => {
    const g = buildGroups(info([sensor('nvme.composite', 'nvme', 84.85), sensor('acpitz.0', 'soc'), sensor('mt7925_phy0.1', 'wireless'), sensor('mlx5.0', 'nic', 105)]));
    expect(g.map((x) => x.id)).toEqual(['gpu', 'soc', 'nvme', 'nic', 'other']);
    expect(g[0]?.sensors[0]).toMatchObject({ key: 'gpu0.temp_c', label: 'NVIDIA GB10', limit: 86, limitLabel: 'slowdown', hardLimit: 90 });
    expect(g[2]?.sensors[0]).toMatchObject({ key: 'temp.nvme.composite', limit: 84.85, limitLabel: 'critical' });
    expect(buildGroups(info([sensor('acpitz.0', 'soc')])).map((x) => x.id)).toEqual(['gpu', 'soc']);
  });

  it('is empty without NodeInfo', () => {
    expect(buildGroups(null)).toEqual([]);
  });
});

describe('readings', () => {
  it('finds the hottest sensor across groups', () => {
    const g = buildGroups(info([sensor('acpitz.0', 'soc'), sensor('acpitz.1', 'soc')]));
    expect(hottest(g, sample({ 'acpitz.0': 66, 'acpitz.1': 74 }))).toEqual({ label: 'acpitz.1', c: 74 });
    expect(hottest(g, none)).toBeNull();
  });

  it('computes headroom with status tones', () => {
    expect(headroom(70, 86)).toEqual({ degrees: 16, tone: 'ok' });
    expect(headroom(83, 86)).toEqual({ degrees: 3, tone: 'warn' });
    expect(headroom(87, 86)).toEqual({ degrees: -1, tone: 'crit' });
    expect(headroom(70, null)).toBeNull();
    expect(headroom(null, 86)).toBeNull();
  });

  it('min/max ignore gaps', () => {
    expect(minMax([null, 3, Number.NaN, 9, 1])).toEqual({ min: 1, max: 9 });
    expect(minMax([])).toEqual({ min: null, max: null });
  });
});

describe('chartSensors', () => {
  it('keeps every sensor when four or fewer', () => {
    const [, soc] = buildGroups(info([0, 1, 2].map((i) => sensor(`acpitz.${i}`, 'soc'))));
    expect(soc && chartSensors(soc, none)).toHaveLength(3);
  });

  it('picks the four hottest, in sensor order', () => {
    const [, soc] = buildGroups(info([0, 1, 2, 3, 4, 5, 6].map((i) => sensor(`acpitz.${i}`, 'soc'))));
    const s = sample({ 'acpitz.0': 60, 'acpitz.1': 72, 'acpitz.2': 61, 'acpitz.3': 70, 'acpitz.4': 69, 'acpitz.5': 71, 'acpitz.6': 50 });
    expect(soc && chartSensors(soc, s).map((x) => x.key)).toEqual(['temp.acpitz.1', 'temp.acpitz.3', 'temp.acpitz.4', 'temp.acpitz.5']);
  });
});

describe('shortLabels', () => {
  it('drops a shared first word', () => {
    expect(shortLabels(['ACPI zone 0', 'ACPI zone 6'])).toEqual(['Zone 0', 'Zone 6']);
    expect(shortLabels(['NVMe Composite', 'NVMe Sensor 1'])).toEqual(['Composite', 'Sensor 1']);
  });
  it('keeps labels that differ, single labels and one-word labels', () => {
    expect(shortLabels(['NVIDIA GB10'])).toEqual(['NVIDIA GB10']);
    expect(shortLabels(['ConnectX-7 ASIC', 'Wi-Fi'])).toEqual(['ConnectX-7 ASIC', 'Wi-Fi']);
    expect(shortLabels(['nvme', 'nvme x'])).toEqual(['nvme', 'nvme x']);
  });
});
