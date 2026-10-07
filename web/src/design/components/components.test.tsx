import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { bytesParts, tempParts } from '../../lib/format';
import { AnimatedNumber } from './AnimatedNumber';
import { Button, IconButton } from './Button';
import { ConfirmDialog } from './Dialog';
import { ErrorBoundary } from './ErrorBoundary';
import { Announcer, DEDUPE_MS, MIN_GAP_MS } from './LiveAnnouncer';
import { ProblemState } from './ProblemState';
import { RingGauge } from './RingGauge';
import { SegmentedControl } from './SegmentedControl';
import { Stat } from './Stat';
import { nodeDisplayStatus, StatusPill } from './StatusPill';
import { Table, sortRows } from './Table';
import { Tabs } from './Tabs';
import { Tooltip } from './Tooltip';
import { Unsupported } from './Unsupported';

describe('SegmentedControl', () => {
  function Harness() {
    const [v, setV] = useState<'live' | '5m' | '1h'>('live');
    return <SegmentedControl label="Time range" value={v} onChange={setV} options={[{ value: 'live', label: 'Live' }, { value: '5m', label: '5m', ariaLabel: 'Last 5 minutes' }, { value: '1h', label: '1h' }]} />;
  }
  it('is a radiogroup with one tab stop and arrow-key selection', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Time range' })).toBeInTheDocument();
    const live = screen.getByRole('radio', { name: 'Live' });
    expect(live).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Last 5 minutes' })).toHaveAttribute('tabindex', '-1');
    live.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Last 5 minutes' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Last 5 minutes' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('radio', { name: '1h' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(live).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Tabs', () => {
  function Harness() {
    const [v, setV] = useState<'a' | 'b'>('a');
    return (
      <Tabs label="Sections" items={[{ id: 'a', label: 'GPU' }, { id: 'b', label: 'CPU' }]} value={v} onChange={setV}>
        <p>panel {v}</p>
      </Tabs>
    );
  }
  it('follows the ARIA tabs pattern', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const gpu = screen.getByRole('tab', { name: 'GPU' });
    expect(gpu).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('GPU');
    gpu.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'CPU' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel b');
    await user.keyboard('{ArrowRight}');
    expect(gpu).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('states consequences, focuses Cancel, and needs the phrase before confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Clear history?" consequences={['Delete 7 days of history on spark1', 'Cannot be undone']} confirmLabel="Clear history" destructive confirmPhrase="DELETE" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByRole('dialog', { name: 'Clear history?' })).toBeInTheDocument();
    expect(screen.getByText('Delete 7 days of history on spark1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Clear history' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type/), 'DELETE');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Escape (cancel event) calls onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Run benchmark?" consequences={['Uses the GPU for 2 min']} confirmLabel="Run" onConfirm={() => undefined} onCancel={onCancel} />);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Table', () => {
  const rows = [{ name: 'b', mem: 2 }, { name: 'a', mem: null }, { name: 'c', mem: 10 }];
  it('sorts with aria-sort and puts nulls last', async () => {
    const user = userEvent.setup();
    render(
      <Table caption="Processes" rowKey={(r) => r.name} rows={rows} columns={[{ id: 'name', header: 'Name', sortValue: (r) => r.name }, { id: 'mem', header: 'Memory', align: 'end', sortValue: (r) => r.mem }]} />,
    );
    const memHeader = screen.getByRole('columnheader', { name: /Memory/ });
    expect(memHeader).toHaveAttribute('aria-sort', 'none');
    await user.click(screen.getByRole('button', { name: /Memory/ }));
    expect(memHeader).toHaveAttribute('aria-sort', 'descending');
    const cells = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(cells()).toEqual(['c10', 'b2', 'a']);
    await user.click(screen.getByRole('button', { name: /Memory/ }));
    expect(memHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(cells()).toEqual(['b2', 'c10', 'a']);
  });
  it('sortRows is stable for equal values', () => {
    expect(sortRows([{ v: 1, i: 0 }, { v: 1, i: 1 }], (r) => r.v, 'asc').map((r) => r.i)).toEqual([0, 1]);
  });
});

describe('StatusPill', () => {
  it('always has an icon and a text label', () => {
    const { container } = render(<><StatusPill status="critical" /><StatusPill status="stale" label="Stale for 12 s" variant="inline" /></>);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Stale for 12 s')).toBeInTheDocument();
    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  });

  it('nodeDisplayStatus: open alerts raise an online node, a lost console makes every known node stale', () => {
    expect(nodeDisplayStatus('online')).toBe('healthy');
    expect(nodeDisplayStatus('online', 'warning')).toBe('warning');
    expect(nodeDisplayStatus('online', 'critical')).toBe('critical');
    expect(nodeDisplayStatus('offline', 'critical')).toBe('offline');
    expect(nodeDisplayStatus('error')).toBe('error');
    expect(nodeDisplayStatus('online', null, false)).toBe('stale');
    expect(nodeDisplayStatus('online', 'critical', false)).toBe('stale');
    expect(nodeDisplayStatus(undefined, null, false)).toBe('unknown');
  });
});

describe('Stat / AnimatedNumber', () => {
  it('renders value and unit, and missing values as a dash', () => {
    const { rerender } = render(<Stat label="GPU temperature" value={71.4} format={tempParts} />);
    expect(screen.getByText('71')).toBeInTheDocument();
    expect(screen.getByText('°C')).toBeInTheDocument();
    rerender(<Stat label="GPU temperature" value={null} format={tempParts} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('°C')).not.toBeInTheDocument();
  });

  it('dims stale values and says when they were last updated', () => {
    const now = Date.now() / 1000;
    const { container } = render(<Stat label="Memory used" value={96 * 1024 ** 3} format={bytesParts} stale updatedAt={now - 12} />);
    expect(container.querySelector('.stat--stale')).not.toBeNull();
    expect(screen.getByText(/Updated 12\ss ago/)).toBeInTheDocument();
  });

  it('shows Unsupported instead of a number', () => {
    render(<Stat label="Power limit" value={null} format={tempParts} unsupported="Not reported by GB10 (NVML: Not Supported)" />);
    expect(screen.getByText('Not reported by this hardware')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Why is this not reported?' })).toHaveAccessibleDescription('Not reported by GB10 (NVML: Not Supported)');
  });

  it('writes the final value immediately under reduced motion', () => {
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: q.includes('reduce'), media: q, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
    const fmt = (n: number) => n.toFixed(0);
    const { container, rerender } = render(<AnimatedNumber value={10} format={fmt} />);
    rerender(<AnimatedNumber value={90} format={fmt} />);
    expect(container.textContent).toBe('90');
    mm.mockRestore();
  });

  it('jumps instead of interpolating when the unit changes (never "48273 Mb/s")', async () => {
    await import('../animate'); // the spring is loaded, so an unchanged unit would animate
    await new Promise((r) => setTimeout(r, 0));
    const { container, rerender } = render(<AnimatedNumber value={48_000} format={(n) => (n / 1000).toFixed(1)} scale="Gb/s" />);
    rerender(<AnimatedNumber value={5} format={(n) => n.toFixed(1)} scale="Mb/s" />);
    expect(container.textContent).toBe('5.0');
  });
});

describe('Tooltip', () => {
  it('opens on focus, links aria-describedby, and Escape dismisses', async () => {
    const user = userEvent.setup();
    render(<Tooltip content="Explains the metric"><button type="button">Info</button></Tooltip>);
    const btn = screen.getByRole('button', { name: 'Info' });
    expect(btn).toHaveAccessibleDescription('Explains the metric');
    await user.tab();
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveAttribute('data-open');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('tooltip', { hidden: true })).not.toHaveAttribute('data-open');
  });
});

describe('ErrorBoundary', () => {
  it('contains a failing child and retries', async () => {
    const user = userEvent.setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('bad data');
      return <p>recovered</p>;
    }
    render(<><ErrorBoundary what="The GPU panel"><Flaky /></ErrorBoundary><p>sibling ok</p></>);
    expect(screen.getByText('The GPU panel couldn’t be displayed'.replace('’', "'"))).toBeInTheDocument();
    expect(screen.getByText('bad data')).toBeInTheDocument();
    expect(screen.getByText('sibling ok')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

describe('ProblemState', () => {
  it('renders cause and fix with inline code', () => {
    render(<ProblemState message="Agent unreachable on spark2" cause="Connection refused on 10.20.20.195:9750" fix="Check `systemctl status sparkline-agent` on spark2" onRetry={() => undefined} />);
    expect(screen.getByText('systemctl status sparkline-agent').tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('Unsupported / RingGauge / Buttons', () => {
  it('have accessible names', () => {
    render(
      <>
        <Unsupported reason="No fan sensors exposed" />
        <RingGauge value={0.79} label="Memory: 79% used" />
        <IconButton aria-label="Close" icon={<svg />} />
        <Button variant="primary">Run</Button>
      </>,
    );
    expect(screen.getByRole('img', { name: 'Memory: 79% used' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toHaveAttribute('type', 'button');
  });
});

describe('Announcer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ignores info, dedupes, rate-limits and summarises bursts', () => {
    const out: string[] = [];
    const a = new Announcer(() => Date.now());
    a.listener = (m) => out.push(m);
    a.announce('GPU hot on spark1', 'info');
    a.announce('GPU hot on spark1', 'warning');
    a.announce('GPU hot on spark1', 'warning');
    act(() => { vi.advanceTimersByTime(0); });
    expect(out).toEqual(['GPU hot on spark1']);
    a.announce('spark2 offline', 'critical');
    a.announce('Link down', 'critical');
    act(() => { vi.advanceTimersByTime(MIN_GAP_MS - 1); });
    expect(out).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(out[1]).toBe('2 new alerts. Latest: Link down');
    act(() => { vi.advanceTimersByTime(DEDUPE_MS); });
    a.announce('GPU hot on spark1', 'warning');
    act(() => { vi.advanceTimersByTime(MIN_GAP_MS); });
    expect(out[2]).toBe('GPU hot on spark1');
  });
});
