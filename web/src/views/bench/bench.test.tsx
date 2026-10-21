import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCluster } from '../../store/cluster';
import { ConfigureDialog } from './ConfigureDialog';
import { LLM, MATMUL, RDMA, result } from './fixtures';
import { History } from './History';
import { Availability, DeltaBadge } from './parts';
import { deltaLook } from './model';

beforeEach(() => {
  useCluster.setState({ order: ['spark1', 'spark2', 'spark3'], nodes: {} });
});

describe('ConfigureDialog', () => {
  it('validates inline, then confirms with the consequences and runs with parsed params', () => {
    const onRun = vi.fn();
    render(<ConfigureDialog spec={MATMUL} open onClose={() => undefined} onRun={onRun} />);
    const iterations = screen.getByLabelText('Iterations');
    fireEvent.change(iterations, { target: { value: '9999' } });
    expect(screen.getByText('Must be between 5 and 500')).toBeInTheDocument();
    expect(iterations).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Review & run/ }));
    expect(screen.queryByRole('button', { name: 'Run benchmark' })).toBeNull();

    fireEvent.change(iterations, { target: { value: '100' } });
    expect(screen.getByText(/≈ 3\smin/)).toBeInTheDocument(); // live estimate: 90 s x 2
    // spark3 is unavailable: disabled, with its problem shown.
    expect(screen.getByRole('checkbox', { name: /spark3/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Review & run/ }));

    expect(screen.getByText('Runs GPU matmul on spark1.')).toBeInTheDocument();
    expect(screen.getByText('You can cancel at any time; cancelling cleans up containers and temp files.')).toBeInTheDocument();
    expect(screen.getByText('Disrupts running workloads')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['spark1'], { dtypes: ['bf16', 'fp16', 'fp8'], size: '8192', iterations: 100 });
  });

  it('offers choices too long for equal segments on a phone as a select', () => {
    const choice = (name: string, label: string, choices: string[]) => ({ name, label, type: 'enum' as const, default: choices[0], min: null, max: null, choices, unit: null, help: null });
    const spec = { ...LLM, params: [choice('api', 'API', ['chat', 'completions']), choice('suite', 'Scenarios', ['standard', 'core', 'hard', 'all'])] };
    render(<ConfigureDialog spec={spec} open onClose={() => undefined} onRun={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'API' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Scenarios' })).toHaveDisplayValue('Standard 69');
  });

  it('picks a source and a target for two-node benches, with the rail next to them', () => {
    const onRun = vi.fn();
    render(<ConfigureDialog spec={RDMA} open onClose={() => undefined} onRun={onRun} />);
    expect(screen.getByLabelText('Source')).toHaveValue('spark1');
    expect(screen.getByLabelText('Target')).toHaveValue('spark2');
    // Choosing the other side's node swaps them, so the pair stays valid.
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'spark2' } });
    expect(screen.getByLabelText('Target')).toHaveValue('spark1');
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Rail' })).getByRole('radio', { name: 'Rail B' }));
    fireEvent.click(screen.getByRole('button', { name: /Review & run/ }));
    expect(screen.getByText('Runs RDMA bandwidth & latency between spark2 (source) and spark1 (target).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    expect(onRun).toHaveBeenCalledWith(['spark2', 'spark1'], { rail: 'B', duration_s: 10 });
  });
});

describe('review fixes', () => {
  it('moves focus to the first invalid field and announces how many to fix', () => {
    render(<ConfigureDialog spec={MATMUL} open onClose={() => undefined} onRun={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Iterations'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /Review & run/ }));
    expect(screen.getByLabelText('Iterations')).toHaveFocus();
    expect(screen.getByText('Fix 1 field to continue.')).toBeInTheDocument();
  });
  it('returns focus to the opener when a conditionally mounted dialog unmounts', () => {
    const { rerender } = render(<button type="button">Configure</button>);
    const opener = screen.getByRole('button', { name: 'Configure' });
    opener.focus();
    rerender(
      <>
        <button type="button">Configure</button>
        <ConfigureDialog spec={MATMUL} open onClose={() => undefined} onRun={() => undefined} />
      </>,
    );
    screen.getByLabelText('Iterations').focus(); // focus is inside the dialog
    expect(opener).not.toHaveFocus();
    rerender(<button type="button">Configure</button>);
    expect(screen.getByRole('button', { name: 'Configure' })).toHaveFocus();
  });
  it('keeps the node picker free of list items under a group role (axe listitem)', () => {
    const { container } = render(<ConfigureDialog spec={MATMUL} open onClose={() => undefined} onRun={() => undefined} />);
    expect(container.ownerDocument.querySelector('.bench-nodes li')).toBeNull();
  });
  it('shows a node that is not reporting as such, even when the catalog says it can run', () => {
    render(<ul><Availability node="spark3" problem={null} nodeStatus="stale" /></ul>);
    expect(screen.getByText('Not reporting')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).toBeNull();
  });
  it('allows ticking only runs of one benchmark for comparison', () => {
    const a = { id: 'r1', bench_id: 'gpu-matmul', params: {}, nodes: ['spark1'], status: 'succeeded' as const, created_ts: 2, started_ts: 2, finished_ts: 3, progress: 1, phase: '', results: [], series: {}, metadata: {}, error: null, log_tail: [], baseline_for: false, params_key: 'k', baseline_run_id: null };
    const b = { ...a, id: 'r2', bench_id: 'rdma-bw-lat', created_ts: 1 };
    render(<History runs={[a, b]} specs={[MATMUL, RDMA]} load={{ state: 'ready', problem: null, reload: () => undefined }} onFirstBaseline={() => undefined} />);
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0] as HTMLElement);
    expect(screen.getAllByRole('checkbox').filter((x) => (x as HTMLInputElement).disabled)).toHaveLength(1);
  });
});

describe('History', () => {
  it('shows the first-baseline empty state with an action', () => {
    const first = vi.fn();
    render(<History runs={[]} specs={[MATMUL]} load={{ state: 'ready', problem: null, reload: () => undefined }} onFirstBaseline={first} />);
    expect(screen.getByText('No benchmark runs yet. Run your first baseline.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure GPU matmul…' }));
    expect(first).toHaveBeenCalled();
  });
});

describe('DeltaBadge', () => {
  it('flags a regression with an icon, the word and the delta (never colour alone)', () => {
    render(<DeltaBadge delta={deltaLook(80, 100, 'higher', 5)} />);
    expect(screen.getByText('Regression')).toBeInTheDocument();
    expect(screen.getByText('−20.0%')).toBeInTheDocument();
    expect(screen.getByText(', worse')).toBeInTheDocument();
  });
  it('reads an improvement as better', () => {
    const r = result({ metric: 'lat', value: 1.5, baseline: 2, better: 'lower' });
    render(<DeltaBadge delta={deltaLook(r.value, r.baseline, r.better, 5)} />);
    expect(screen.queryByText('Regression')).toBeNull();
    expect(screen.getByText(', better')).toBeInTheDocument();
  });
});
