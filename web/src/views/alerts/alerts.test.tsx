import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AlertRule, Event } from '../../lib/types';
import { useEvents } from '../../store/events';
import { OpenAlerts } from './OpenAlerts';
import { RulesEditor } from './RulesEditor';
import { useAck } from './useAck';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const alert: Event = { id: 7, ts: Date.now() / 1000 - 60, node_id: 'spark1', severity: 'critical', kind: 'alert', rule_id: 'gpu_temp_critical', title: 'GPU temperature critical on spark1', detail: '87 °C for 10 s (threshold 85 °C)', metric: 'gpu0.temp_c', value: 87, resolved_ts: null, acked: false };

function Harness() {
  const acker = useAck();
  return <OpenAlerts loading={false} acker={acker} />;
}

describe('OpenAlerts acknowledge', () => {
  beforeEach(() => { useEvents.setState({ events: [alert] }); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('acks optimistically and keeps it when the console agrees', async () => {
    let resolve: (r: Response) => void = () => undefined;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Acknowledge: GPU temperature critical/ }));
    expect(screen.getByText('Acknowledged')).toBeInTheDocument(); // before the server answered
    resolve(json({ ...alert, acked: true }));
    await waitFor(() => { expect(useEvents.getState().events[0]?.acked).toBe(true); });
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/events/7/ack', expect.objectContaining({ method: 'POST' }));
  });

  it('rolls back and explains when the ack fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ problem: { message: 'No event 7', cause: 'It may have expired (events are kept 30 days)', fix: '' } }, 404));
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Acknowledge:/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No event 7');
    expect(useEvents.getState().events[0]?.acked).toBe(false);
    expect(screen.getByRole('button', { name: /Acknowledge:/ })).toBeEnabled();
  });

  it('has a calm empty state', () => {
    useEvents.setState({ events: [] });
    render(<Harness />);
    expect(screen.getByText('No open alerts')).toBeInTheDocument();
  });
});

const RULES: AlertRule[] = [
  { id: 'gpu_temp_high', name: 'GPU temperature high', enabled: true, kind: 'threshold', metric: 'gpu0.temp_c', op: '>', threshold: 80, for_s: 30, severity: 'warning', nodes: null },
  { id: 'mem_available_low', name: 'Memory running low', enabled: true, kind: 'threshold', metric: 'mem.available', op: '<', threshold: 8 * 1024 ** 3, for_s: 30, severity: 'warning', nodes: null },
  { id: 'gpu_throttle', name: 'GPU throttling', enabled: true, kind: 'throttle', metric: 'gpu0.throttle_mask', op: '>', threshold: 0xe8, for_s: 10, severity: 'warning', nodes: null },
];

describe('RulesEditor', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('edits inline with validation, dirty state, revert and save', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      Promise.resolve(init?.method === 'PUT' ? json(JSON.parse(init.body as string)) : json(RULES)),
    );
    render(<RulesEditor />);
    const memThreshold = await screen.findByRole('textbox', { name: /Memory running low: threshold in GiB/ });
    expect(memThreshold).toHaveValue('8');
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    await user.clear(memThreshold);
    await user.type(memThreshold, 'lots');
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Fix the highlighted fields to save');

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(memThreshold).toHaveValue('8');

    await user.clear(memThreshold);
    await user.type(memThreshold, '12');
    await user.click(screen.getByRole('checkbox', { name: 'Power cap' }));
    await user.click(screen.getByRole('switch', { name: 'Enable rule: GPU temperature high' }));
    expect(screen.getByRole('status')).toHaveTextContent('3 unsaved changes');
    await user.click(save);
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Saved'); });
    const put = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PUT');
    const sent = JSON.parse(put?.[1]?.body as string) as AlertRule[];
    expect(sent[0]?.enabled).toBe(false);
    expect(sent[1]?.threshold).toBe(12 * 1024 ** 3);
    expect(sent[2]?.threshold).toBe(0xec);
  });

  it('shows API validation errors inline on the offending rule', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      Promise.resolve(init?.method === 'PUT'
        ? json({ problem: { message: 'Invalid alert rules', cause: "Rule 'gpu_temp_high': for_s must be >= 0", fix: 'Fix the rule and save again' } }, 422)
        : json(RULES)),
    );
    render(<RulesEditor />);
    const forField = await screen.findByRole('textbox', { name: /GPU temperature high: for how many seconds/ });
    await user.clear(forField);
    await user.type(forField, '20');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Rule 'gpu_temp_high': for_s must be >= 0");
    const row = forField.closest('tr');
    expect(row).toHaveClass('is-rejected');
    expect(within(row as HTMLElement).getByText(/The console rejected this rule/)).toBeInTheDocument();
  });
});
