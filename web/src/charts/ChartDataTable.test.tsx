import { render, screen } from '@testing-library/react';
import { ChartDataTable, downsampleRows } from './ChartDataTable';
import { orderCores } from './Heatmap';
import { unsupportedReason } from './TimeSeriesChart';

describe('downsampleRows', () => {
  it('bucket-averages to at most maxRows, ignoring gaps', () => {
    const ts = Array.from({ length: 180 }, (_, i) => i);
    const rows = downsampleRows(ts, [{ label: 'a', values: ts.map((i) => (i % 2 ? null : i)) }], 60);
    expect(rows).toHaveLength(60);
    expect(rows[0]).toEqual({ ts: 2, values: [1] }); // mean of 0 and 2 (1 is a gap)
  });
  it('keeps short series as-is and handles empty input', () => {
    expect(downsampleRows([1, 2], [{ label: 'a', values: [5, null] }], 60)).toEqual([{ ts: 1, values: [5] }, { ts: 2, values: [null] }]);
    expect(downsampleRows([], [], 60)).toEqual([]);
  });
});

describe('ChartDataTable', () => {
  it('renders an accessible table with formatted values', () => {
    render(<ChartDataTable caption="GPU temperature" ts={[0, 1]} series={[{ label: 'GPU', values: [70, null] }]} format={(n) => `${n} °C`} />);
    expect(screen.getByRole('table', { name: /GPU temperature/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'GPU' })).toBeInTheDocument();
    expect(screen.getByText('70 °C')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('chart helpers', () => {
  it('finds unsupported reasons by exact key or prefix', () => {
    const info = { unsupported: [{ metric: 'gpu0.power_limit_w', reason: 'NVML: Not Supported' }, { metric: 'fan', reason: 'No fan sensors' }] };
    expect(unsupportedReason(info as never, 'gpu0.power_limit_w')).toBe('NVML: Not Supported');
    expect(unsupportedReason(info as never, 'fan.0.rpm')).toBe('No fan sensors');
    expect(unsupportedReason(info as never, 'fans')).toBeNull();
    expect(unsupportedReason(null, 'x')).toBeNull();
  });
  it('orders cores performance first, then efficiency', () => {
    const cores = [0, 5, 10, 15].map((id) => ({ id, kind: id % 10 < 5 ? 'efficiency' : 'performance', model: null, max_mhz: null, cluster: null }) as const);
    expect(orderCores(cores).map((r) => r.core.id)).toEqual([5, 15, 0, 10]);
  });
});
