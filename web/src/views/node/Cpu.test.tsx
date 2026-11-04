import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import gb10Info from '../../test/fixtures/platforms/gb10/info.json';
import gb10Sample from '../../test/fixtures/platforms/gb10/sample.json';
import wsInfo from '../../test/fixtures/platforms/workstation/info.json';
import wsSample from '../../test/fixtures/platforms/workstation/sample.json';
import type { SeriesSpec } from '../../charts/TimeSeriesChart';
import type { CoreInfo, NodeInfo, NodeState, Sample } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { useConnection } from '../../store/connection';
import { liveStore } from '../../store/live';
import { usePrefs } from '../../store/prefs';
import Cpu from './Cpu';
import Summary from './Summary';

interface ChartProps { title: string; series: readonly SeriesSpec[] }
const charts: ChartProps[] = [];
vi.mock('../../charts/TimeSeriesChart', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../charts/TimeSeriesChart')>()),
  TimeSeriesChart: (p: ChartProps) => {
    charts.push(p);
    return null;
  },
}));

interface Platform { info: NodeInfo; sample: Sample }
const platform = (info: unknown, sample: unknown): Platform => ({ info: info as NodeInfo, sample: sample as Sample });
const workstation = platform(wsInfo, wsSample);
const gb10 = platform(gb10Info, gb10Sample);

const THREADRIPPER = 'AMD Ryzen Threadripper PRO 7975WX 32-Cores';
const RAPTOR_LAKE = '13th Gen Intel(R) Core(TM) i9-13900K';
const ROWS = 'One row per core, coloured by utilisation (scale below).';

function intelHybrid(): Platform {
  const cores = Array.from({ length: 32 }, (_, id): CoreInfo => (
    id < 16 ? { id, kind: 'performance', model: RAPTOR_LAKE, max_mhz: 5800, cluster: null } : { id, kind: 'efficiency', model: RAPTOR_LAKE, max_mhz: 4300, cluster: null }
  ));
  const { cpu } = workstation.sample;
  return {
    info: { ...workstation.info, cpu_model: RAPTOR_LAKE, cores },
    sample: { ...workstation.sample, cpu: { ...cpu, perf_util: 41, eff_util: 12, per_core: cpu.per_core.slice(0, 32), freq_mhz: cpu.freq_mhz.slice(0, 32) } },
  };
}

function land(p: Platform, sample: Sample = p.sample) {
  act(() => {
    liveStore.pushSample({ ...sample, node_id: p.info.node_id, ts: Date.now() / 1000 - 5 });
    liveStore.flush();
  });
}

function show(p: Platform, View: ComponentType<{ nodeId: string }> = Cpu, { status = 'online', sample = p.sample }: { status?: NodeState['status']; sample?: Sample | null } = {}) {
  const id = p.info.node_id;
  liveStore.removeNode(id);
  useCluster.setState({ clockOffset: 0, nodes: { [id]: { node_id: id, url: '', status, since: 0, last_sample_ts: null, error: null, info: p.info, next_retry_ts: null } } });
  if (sample) land(p, sample);
  return render(
    <Router hook={memoryLocation({ path: '/' }).hook}>
      <View nodeId={id} />
    </Router>,
  );
}

const region = (name: string) => screen.getByRole('region', { name });
const chart = (title: string) => charts.findLast((c) => c.title === title);
const stat = (label: string) => {
  const el = screen.getByText(label, { selector: '.stat__label' }).closest('.stat');
  if (!(el instanceof HTMLElement)) throw new Error(`no stat ${label}`);
  return el;
};
const timesSaid = (text: string) => document.body.textContent.split(text).length - 1;

beforeEach(() => {
  charts.length = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  usePrefs.setState({ timeRange: 'live' });
  useConnection.setState({ status: 'live', everLive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Summary CPU chart', () => {
  it('charts overall CPU utilisation as "All cores" when the node has no performance/efficiency split', () => {
    show(workstation, Summary);
    expect(within(region('CPU utilisation')).getByText('All cores')).toBeInTheDocument();
    const series = chart('CPU utilisation')?.series;
    expect(series).toEqual([{ key: 'cpu.util', label: 'All cores' }]);
    for (const s of series ?? []) expect(liveStore.latestValue(workstation.info.node_id, s.key), s.key).not.toBeNull();
  });

  it('still charts performance and efficiency cores on GB10', () => {
    show(gb10, Summary);
    expect(within(region('CPU utilisation')).getByText('By core type')).toBeInTheDocument();
    const series = chart('CPU utilisation by core type')?.series;
    expect(series).toEqual([{ key: 'cpu.perf_util', label: 'Performance' }, { key: 'cpu.eff_util', label: 'Efficiency' }]);
    for (const s of series ?? []) expect(liveStore.latestValue(gb10.info.node_id, s.key), s.key).not.toBeNull();
  });
});

describe('CPU tab before its first sample lands', () => {
  for (const [name, p, tiles] of [['the workstation', workstation, 4], ['GB10', gb10, 6]] as const) {
    it(`holds a place for each of the ${tiles} stats it shows on ${name}`, () => {
      show(p, Cpu, { sample: null });
      expect(region('CPU summary').querySelectorAll('.ph-stat')).toHaveLength(tiles);
      land(p);
      expect(region('CPU summary').querySelectorAll('.stat')).toHaveLength(tiles);
    });
  }
});

describe('CPU tab on the workstation (x86, no core split)', () => {
  it('names the CPU by its product name, never per core or counted, and calls its only group "All cores"', () => {
    show(workstation);
    expect(within(region('Per-core utilisation')).getByText(`${THREADRIPPER}, up to 5.30 GHz. ${ROWS}`)).toBeInTheDocument();
    const group = region('All cores');
    expect(within(group).getByText('All cores')).toBeInTheDocument();
    expect(within(group).getByText(`${THREADRIPPER} · up to 5.30 GHz`)).toBeInTheDocument();
    const cells = within(group).getAllByRole('img');
    expect(cells).toHaveLength(64);
    for (const cell of cells) expect(cell).toHaveAccessibleName(/^Core \d+: /);
    expect(document.body).not.toHaveTextContent(/\bOther\b/);
    expect(document.body).not.toHaveTextContent('64 ×');
  });

  it('reads a heatmap row out by group, without the product name', () => {
    show(workstation);
    const heatmap = screen.getByRole('img', { name: /^Per-core CPU utilisation/ });
    fireEvent.keyDown(heatmap, { key: 'ArrowDown' });
    expect(heatmap.parentElement?.querySelector('[aria-live="polite"]')).toHaveTextContent(/^Core 0 · All cores: \d+% now/);
  });

  it('charts the utilisation of all cores rather than by core type', () => {
    show(workstation);
    expect(within(region('Utilisation')).getByText('Average across all cores')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Utilisation by core type' })).not.toBeInTheDocument();
    expect(chart('CPU utilisation')?.series).toEqual([{ key: 'cpu.util', label: 'All cores' }]);
  });
});

describe('CPU tab on an Intel hybrid desktop (x86, core split)', () => {
  it('shows performance and efficiency groups and says the product name once', () => {
    show(intelHybrid());
    expect(stat('Performance cores')).toHaveTextContent('16 cores');
    expect(stat('Efficiency cores')).toHaveTextContent('16 cores');
    expect(chart('CPU utilisation by core type')?.series).toEqual([{ key: 'cpu.perf_util', label: 'Performance' }, { key: 'cpu.eff_util', label: 'Efficiency' }]);
    expect(within(region('Per-core utilisation')).getByText(`${RAPTOR_LAKE}: performance cores (up to 5.80 GHz) above efficiency cores (up to 4.30 GHz). ${ROWS}`)).toBeInTheDocument();
    expect(within(region('Performance cores')).getByText('16 cores · up to 5.80 GHz')).toBeInTheDocument();
    expect(within(region('Efficiency cores')).getByText('16 cores · up to 4.30 GHz')).toBeInTheDocument();
    expect(timesSaid(RAPTOR_LAKE)).toBe(1);
    expect(document.body).not.toHaveTextContent('16 ×');
  });
});

describe('CPU tab on GB10', () => {
  it('keeps naming each group by its core design', () => {
    show(gb10);
    expect(within(region('Per-core utilisation')).getByText(`Performance cores (Cortex-X925, up to 3.90 GHz) above efficiency cores (Cortex-A725, up to 2.81 GHz). ${ROWS}`)).toBeInTheDocument();
    expect(stat('Performance cores')).toHaveTextContent('10 × Cortex-X925');
    expect(within(region('Performance cores')).getByText('10 × Cortex-X925 · up to 3.90 GHz')).toBeInTheDocument();
    expect(within(region('Utilisation by core type')).getByText('Average across the cores of each kind')).toBeInTheDocument();
    expect(chart('CPU utilisation by core type')?.series).toEqual([{ key: 'cpu.perf_util', label: 'Performance (Cortex-X925)' }, { key: 'cpu.eff_util', label: 'Efficiency (Cortex-A725)' }]);
  });
});

describe('CPU temperature stat', () => {
  const withTemp = (c: number | null): Sample => ({ ...workstation.sample, cpu_temp_c: c });

  it('shows the hottest CPU sensor reading on the workstation', () => {
    show(workstation, Cpu, { sample: withTemp(67.4) });
    expect(stat('CPU temperature')).toHaveTextContent('67°C');
    expect(stat('CPU temperature')).toHaveTextContent('Hottest CPU sensor');
  });

  it('says "No data", like its neighbours, while a reported sensor has no reading', () => {
    show(workstation, Cpu, { sample: withTemp(null) });
    expect(stat('CPU temperature')).toHaveTextContent('No data');
    expect(stat('CPU temperature').querySelector('.skeleton')).toBeNull();
  });

  it('keeps the last reading, dimmed, once the node stops reporting', () => {
    show(workstation, Cpu, { status: 'stale', sample: withTemp(67.4) });
    expect(stat('CPU temperature')).toHaveTextContent('67°C');
    expect(stat('CPU temperature')).toHaveClass('stat--stale');
  });

  it('says "Not reported" on GB10', () => {
    show(gb10);
    expect(stat('CPU temperature')).toHaveTextContent(/^CPU temperatureNot reported/);
    expect(stat('CPU temperature')).not.toHaveTextContent('Hottest CPU sensor');
  });
});
