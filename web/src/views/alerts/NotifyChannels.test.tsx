import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotifyChannelStatus } from '../../lib/types';
import { NotifyChannels } from './NotifyChannels';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const now = () => Date.now() / 1000;

const phone: NotifyChannelStatus = { name: 'phone', kind: 'ntfy', host: 'ntfy.sh', min_severity: 'critical', send_resolved: true, pending: 0, retry_at: null, last: null };
const team: NotifyChannelStatus = {
  name: 'team',
  kind: 'discord',
  host: 'discord.com',
  min_severity: 'warning',
  send_resolved: false,
  pending: 3,
  retry_at: new Date(2026, 0, 2, 14, 32, 5).getTime() / 1000,
  last: {
    ts: now() - 240,
    ok: false,
    test: false,
    notices: 3,
    failure: 'server_error',
    http_status: 503,
    problem: { message: "Could not send to 'team'", cause: 'HTTP 503 from discord.com.', fix: 'The service is failing. Waiting alerts are sent again automatically.' },
  },
};
const rejected = { message: "Could not send to 'phone'", cause: 'HTTP 404 from ntfy.sh.', fix: "Put a working url in [[notify]] 'phone' in console.toml, then restart the console." };

function serve(rows: NotifyChannelStatus[], tested: (name: string) => Response = () => json({})) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const test = /\/notify\/channels\/([^/]+)\/test$/.exec(typeof url === 'string' ? url : '');
    return Promise.resolve(test?.[1] && init?.method === 'POST' ? tested(decodeURIComponent(test[1])) : json(rows));
  });
}

const row = (name: string) => within(screen.getByText(name, { selector: '.notify-channel__name' }).closest('tr') as HTMLElement);

describe('NotifyChannels', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows how to add a channel when there is none', async () => {
    serve([]);
    render(<NotifyChannels />);
    expect(await screen.findByText('No notification channels')).toBeInTheDocument();
    const snippet = screen.getByText(/^\[\[notify\]\]/, { selector: 'pre code' });
    expect(snippet).toHaveTextContent('kind = "ntfy"');
    expect(snippet).toHaveTextContent('url = "https://ntfy.sh/<your-topic>"');
    expect(screen.queryByRole('button', { name: /Send test/ })).not.toBeInTheDocument();
  });

  it('lists each channel with its host, what it sends and how the last delivery went', async () => {
    const fetchSpy = serve([phone, team]);
    render(<NotifyChannels />);
    expect(await screen.findByRole('table', { name: 'Notification channels' })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/notify/channels', expect.anything());

    const first = row('phone');
    expect(first.getByText('ntfy')).toBeInTheDocument();
    expect(first.getByText('ntfy.sh')).toBeInTheDocument();
    expect(first.getByText('Critical only, and recoveries')).toBeInTheDocument();
    expect(first.getByText('Nothing sent since the console started')).toBeInTheDocument();

    const second = row('team');
    expect(second.getByText('Discord')).toBeInTheDocument();
    expect(second.getByText('Warning and above')).toBeInTheDocument();
    expect(second.getByText('Failed')).toBeInTheDocument();
    expect(second.getByText('HTTP 503 from discord.com.')).toBeInTheDocument();
    expect(second.getByText('3 waiting, next try at 14:32:05')).toBeInTheDocument();
  });

  it('sends a test and shows the delivery in the row', async () => {
    const delivered: NotifyChannelStatus = { ...phone, last: { ts: now(), ok: true, test: true, notices: 0, failure: null, http_status: 200, problem: null } };
    const fetchSpy = serve([phone, team], () => json(delivered));
    render(<NotifyChannels />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test to phone' }));
    expect(await row('phone').findByText('Delivered')).toBeInTheDocument();
    expect(row('phone').getByText(/^Test,/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Test sent to phone');
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/notify/channels/phone/test', expect.objectContaining({ method: 'POST' }));
    expect(row('team').getByText('Failed')).toBeInTheDocument();
  });

  it('shows why a test could not be delivered, in the row and with its fix', async () => {
    const failed: NotifyChannelStatus = { ...phone, last: { ts: now(), ok: false, test: true, notices: 0, failure: 'rejected', http_status: 404, problem: rejected } };
    serve([phone], () => json(failed));
    render(<NotifyChannels />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test to phone' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Could not send to 'phone'");
    expect(alert).toHaveTextContent('HTTP 404 from ntfy.sh');
    expect(alert).toHaveTextContent("Put a working url in [[notify]] 'phone' in console.toml");
    expect(row('phone').getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test to phone' })).toBeEnabled();
  });

  it('says so when the console itself refuses the test', async () => {
    serve([phone], () => json({ problem: { message: "No notification channel 'phone'", cause: 'It is not in the console configuration', fix: '' } }, 404));
    render(<NotifyChannels />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test to phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("No notification channel 'phone'");
    expect(row('phone').getByText('Nothing sent since the console started')).toBeInTheDocument();
  });

  it('offers a retry when the channels cannot be loaded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ problem: { message: 'Console restarting', cause: '', fix: '' } }, 503));
    render(<NotifyChannels />);
    expect(await screen.findByText('Console restarting')).toBeInTheDocument();
    fetchSpy.mockResolvedValue(json([phone]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Send test to phone' })).toBeInTheDocument();
  });

  it('refreshes every 15 s and keeps the rows when a refresh fails', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json([phone]));
    render(<NotifyChannels />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('Nothing sent since the console started')).toBeInTheDocument();

    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Nothing sent since the console started')).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(json([{ ...phone, last: { ts: now(), ok: true, test: false, notices: 2, failure: null, http_status: 200, problem: null } }]));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });
});
