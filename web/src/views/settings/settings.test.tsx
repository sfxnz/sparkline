import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeState } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { DataSection } from './DataSection';

const node = (id: string, status: NodeState['status']): NodeState => ({ node_id: id, url: '', status, since: 0, last_sample_ts: null, error: null, info: null, next_retry_ts: null });

describe('Clear history', () => {
  beforeEach(() => {
    useCluster.setState({ order: ['spark1', 'spark3'], nodes: { spark1: node('spark1', 'online'), spark3: node('spark3', 'offline') } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('states consequences, requires typing the node name, then calls DELETE with confirm', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    render(<DataSection />);
    // Each button names its node for assistive tech (three identical "Clear history…" would be indistinguishable).
    expect(screen.getByRole('button', { name: 'Clear history for spark3…' })).toBeDisabled(); // spark3 is offline
    await user.click(screen.getByRole('button', { name: 'Clear history for spark1…' }));
    expect(screen.getByRole('dialog', { name: 'Clear history for spark1?' })).toBeInTheDocument();
    expect(screen.getByText('Delete all stored history for spark1 (7 days at 10 s, 30 days at 1 min).')).toBeInTheDocument();
    expect(screen.getByText('Leave live data unaffected.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Clear history' });
    await user.type(screen.getByLabelText(/Type/), 'spark2');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText(/Type/));
    await user.type(screen.getByLabelText(/Type/), 'spark1');
    await user.click(confirm);
    await waitFor(() => { expect(screen.getByText('History cleared on spark1')).toBeInTheDocument(); });
    expect(fetchSpy).toHaveBeenCalledWith('/api/v1/history?node=spark1', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) }));
  });
});
