import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Mock } from 'vitest';
import type { RecommendationsView } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import Recommendations from '../Recommendations';
import { displayMemory, gpuCap, headless, item, measurement, noHelper, node, unreachable, view } from './fixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The console: GET answers with `answer.view` (a test changes it between polls), POST with `posted()`. */
function serve(first: RecommendationsView, posted: () => Response = () => json({ ok: true }, 202)) {
  const answer = { view: first };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => Promise.resolve(init?.method === 'POST' ? posted() : json(answer.view)));
  return { answer, fetchSpy };
}

const card = (title: string) => within(screen.getByRole('region', { name: title }));
const row = (title: string, nodeId: string) => within(card(title).getByText(nodeId, { selector: '.rec-node__name' }).closest('li') as HTMLElement);
const tick = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));
/** The block that shows exactly these commands, one per line. */
const commands = (lines: string[]) => (_text: string, el: Element | null) => el?.tagName === 'CODE' && el.textContent === lines.join('\n');

const GPU = gpuCap.title;
const BY_HAND = 'These commands are for making the change by hand, without Sparkline. A setting that Sparkline applied must be undone with Undo, not by hand:';
const BY_HAND_CAP = `${BY_HAND} Sparkline keeps its own record and applies the setting again at every boot.`;
const BY_HAND_BOOT = `${BY_HAND} Sparkline keeps its own record of what it applied.`;
const notApplied = item(gpuCap.id, 'not-applied', 'No cap found');
const applied = item(gpuCap.id, 'applied', 'Capped at 2200 MHz by Sparkline', { managed: true, last: { action: 'apply', ts: 200, ok: true, message: 'GPU clock capped at 2200 MHz' } });

/** Open the page on one node where the GPU cap is recommended, with the clock stopped. */
async function openOnSpark2(first = notApplied, posted?: () => Response) {
  vi.useFakeTimers();
  const console = serve(view([gpuCap], { spark2: node([first]) }), posted);
  render(<Recommendations />);
  await tick();
  return console;
}

function confirmApply() {
  fireEvent.click(screen.getByRole('button', { name: `Apply ${GPU} on spark2` }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply on spark2' }));
}

describe('Recommendations', () => {
  beforeEach(() => {
    useCluster.setState({ order: ['spark1', 'spark2', 'spark3', 'spark4'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useCluster.setState({ order: [] });
  });

  describe('what each node says', () => {
    beforeEach(() => {
      serve(
        view(
          [gpuCap],
          {
            spark5: node([item(gpuCap.id, 'unknown', 'nvidia-smi did not answer')]),
            spark4: null,
            spark3: node([item(gpuCap.id, 'not-applicable', 'This setting is for the DGX Spark, and this node has no GB10')]),
            spark2: node([notApplied]),
            spark1: node([item(gpuCap.id, 'applied', 'Capped at 2200 MHz by nvidia-lock-clocks.service')]),
          },
          { spark4: unreachable },
        ),
      );
      render(<Recommendations />);
    });

    it('lists the nodes in console order, each with its state in words and what the check read', async () => {
      expect(await screen.findByRole('heading', { name: GPU })).toBeInTheDocument();
      const names = within(card(GPU).getByRole('list', { name: `${GPU}: your nodes` })).getAllByRole('listitem').map((li) => li.querySelector('.rec-node__name')?.textContent);
      expect(names).toEqual(['spark1', 'spark2', 'spark3', 'spark4', 'spark5']);

      expect(row(GPU, 'spark2').getByText('Recommended')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByText('No cap found')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByRole('button', { name: `Apply ${GPU} on spark2` })).toBeInTheDocument();

      expect(row(GPU, 'spark3').getByText('Not applicable')).toBeInTheDocument();
      expect(row(GPU, 'spark3').getByText('This setting is for the DGX Spark, and this node has no GB10')).toBeInTheDocument();
      expect(row(GPU, 'spark3').queryByRole('button')).not.toBeInTheDocument();

      expect(row(GPU, 'spark5').getByText('Unknown')).toBeInTheDocument();
      expect(row(GPU, 'spark5').getByText('nvidia-smi did not answer')).toBeInTheDocument();
      expect(row(GPU, 'spark5').queryByRole('button')).not.toBeInTheDocument();

      expect(card(GPU).getByText('Recommended on 1 of 5 nodes')).toBeInTheDocument();
    });

    it('says a setting applied by other means is applied outside Sparkline, with no Undo', async () => {
      await screen.findByRole('heading', { name: GPU });
      const spark1 = row(GPU, 'spark1');
      expect(spark1.getByText('Applied')).toBeInTheDocument();
      expect(spark1.getByText('Capped at 2200 MHz by nvidia-lock-clocks.service')).toBeInTheDocument();
      expect(spark1.getByText(/Applied outside Sparkline/)).toBeInTheDocument();
      expect(spark1.queryByRole('button')).not.toBeInTheDocument();
    });

    it('shows why a node gave no answer', async () => {
      await screen.findByRole('heading', { name: GPU });
      const spark4 = row(GPU, 'spark4');
      expect(spark4.getByText('No answer')).toBeInTheDocument();
      expect(spark4.getByText('Agent unreachable on spark4')).toBeInTheDocument();
      expect(spark4.getByText('Connection refused')).toBeInTheDocument();
      expect(spark4.getByText('systemctl status sparkline-agent', { selector: 'code' })).toBeInTheDocument();
      expect(spark4.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  it('offers Undo on a setting that Sparkline applied', async () => {
    serve(view([gpuCap], { spark2: node([applied]) }));
    render(<Recommendations />);
    const spark2 = row((await screen.findByRole('heading', { name: GPU })).textContent, 'spark2');
    expect(spark2.getByText('Applied')).toBeInTheDocument();
    expect(spark2.getByRole('button', { name: `Undo ${GPU} on spark2` })).toBeInTheDocument();
    expect(spark2.queryByText(/outside Sparkline/)).not.toBeInTheDocument();
  });

  it('leads with what is still recommended, and puts a setting applied on every node last', async () => {
    serve(
      view([headless, gpuCap], {
        spark1: node([item(headless.id, 'applied', 'Boots without the desktop', { managed: true }), notApplied]),
        spark2: node([item(headless.id, 'applied', 'Boots without the desktop'), applied]),
      }),
    );
    render(<Recommendations />);
    await screen.findByRole('heading', { name: GPU });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([GPU, headless.title]);
    expect(card(headless.title).getByText('Applied on every node')).toBeInTheDocument();
    expect(card(GPU).getByText('Recommended on 1 of 2 nodes')).toBeInTheDocument();
    expect(screen.getByText(/^1 of 2 settings has something to apply on your nodes\./)).toBeInTheDocument();
  });

  describe('evidence', () => {
    it('calls an unmeasured setting a community claim, with nothing that reads as measured', async () => {
      serve(view([gpuCap], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      expect(await screen.findByText('Not measured by Sparkline yet: community claim')).toBeInTheDocument();
      expect(screen.queryByText(/Measured on/)).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Evidence file/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('shows a measurement with its numbers before and after, its method and its evidence file', async () => {
      serve(view([{ ...gpuCap, measurement, verified: true }], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      expect(await screen.findByText('Measured on a DGX Spark')).toBeInTheDocument();
      expect(screen.queryByText(/Not measured/)).not.toBeInTheDocument();
      expect(screen.getByText(/2026-11-20 · DGX Spark Founders Edition, firmware OTA2610/)).toBeInTheDocument();
      const power = within(screen.getByRole('row', { name: /GPU power under load/ }));
      expect(power.getByText('84 W')).toBeInTheDocument();
      expect(power.getByText('51 W')).toBeInTheDocument();
      expect(within(screen.getByRole('row', { name: /Decode speed/ })).getByText('51.4 tokens/s')).toBeInTheDocument();
      expect(screen.getByText(measurement.method)).toBeInTheDocument();
      const file = screen.getByRole('link', { name: /Evidence file/ });
      expect(file).toHaveAttribute('href', expect.stringMatching(/\/docs\/recommendations\/gpu-clock-cap\.md$/));
      expect(file).toHaveAttribute('target', '_blank');
    });
  });

  it('shows the claim, the cost, the risks, whether it survives a reboot, and sources that open in a new tab', async () => {
    serve(view([gpuCap, headless], { spark2: node([notApplied, item(headless.id, 'not-applied', 'Boots to the desktop')]) }));
    render(<Recommendations />);
    await screen.findByRole('heading', { name: GPU });
    const gpu = card(GPU);
    expect(gpu.getByText(gpuCap.summary)).toBeInTheDocument();
    expect(gpu.getByText('Makes the machine cooler')).toBeInTheDocument();
    expect(gpu.getByText(gpuCap.benefit)).toBeInTheDocument();
    expect(gpu.getByText(gpuCap.cost)).toBeInTheDocument();
    expect(gpu.getByRole('heading', { name: 'What could go wrong' })).toBeInTheDocument();
    for (const risk of gpuCap.risks) expect(gpu.getByText(risk)).toBeInTheDocument();
    expect(gpu.getByText(/^Not on its own\. When Sparkline applies it, Sparkline applies it again at every boot/)).toBeInTheDocument();
    expect(card(headless.title).getByText('Yes. It stays until it is undone.')).toBeInTheDocument();
    for (const source of gpuCap.sources) {
      const link = gpu.getByRole('link', { name: (name) => name.startsWith(source.title) });
      expect(link).toHaveTextContent('(opens in a new tab)');
      expect(link).toHaveAttribute('href', source.url);
      expect(link).toHaveAttribute('target', '_blank');
    }
  });

  describe('the commands by hand', () => {
    let writeText: Mock<(text: string) => Promise<void>>;
    beforeEach(() => {
      writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
      Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    it('copies the exact apply and undo commands', async () => {
      serve(view([gpuCap], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      await userEvent.click(await screen.findByRole('button', { name: `Copy the commands to apply ${GPU}` }));
      expect(writeText).toHaveBeenLastCalledWith(gpuCap.apply.join('\n'));
      expect(await screen.findByText('Copied', { selector: '[role="status"]' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: `Copy the commands to undo ${GPU}` }));
      expect(writeText).toHaveBeenLastCalledWith(gpuCap.undo.join('\n'));
    });

    it('gives a node without the helper its fix and the commands instead of a button', async () => {
      serve(view([gpuCap], { spark2: node([notApplied]), spark3: node([notApplied], noHelper) }));
      render(<Recommendations />);
      await screen.findByRole('heading', { name: GPU });
      const spark3 = row(GPU, 'spark3');
      expect(spark3.getByText('Recommended')).toBeInTheDocument();
      expect(spark3.getByText(noHelper.message)).toBeInTheDocument();
      expect(spark3.getByText(noHelper.fix)).toBeInTheDocument();
      expect(spark3.queryByRole('button')).not.toBeInTheDocument();
      expect(card(GPU).getByText(commands(gpuCap.apply))).toBeVisible();
      // The node beside it still takes a click.
      expect(row(GPU, 'spark2').getByRole('button', { name: `Apply ${GPU} on spark2` })).toBeInTheDocument();
    });

    it('says beside a one-click setting’s commands that they do not undo what Sparkline applied', async () => {
      serve(view([gpuCap, headless, displayMemory], { spark3: node([notApplied, item(headless.id, 'not-applied', 'Boots to the desktop'), item(displayMemory.id, 'not-applied', 'Set to 2 GB')], noHelper) }));
      render(<Recommendations />);
      await screen.findByRole('heading', { name: GPU });
      expect(card(GPU).getByText(BY_HAND_CAP)).toBeVisible();
      expect(card(headless.title).getByText(BY_HAND_BOOT)).toBeVisible();
      // Not one-click: Sparkline never applies it, so there is nothing of Sparkline's to undo.
      expect(card(displayMemory.title).queryByText(/must be undone with Undo/)).not.toBeInTheDocument();
    });

    it('keeps the commands folded away while every node takes a click', async () => {
      serve(view([gpuCap], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      await screen.findByRole('heading', { name: GPU });
      expect(card(GPU).getByText(commands(gpuCap.apply))).not.toBeVisible();
    });

    it('shows the steps of a setting that is not one-click, and never a button', async () => {
      serve(view([displayMemory], { spark1: node([item(displayMemory.id, 'not-applied', 'Set to 2 GB: 2048 MiB reserved')]), spark2: node([item(displayMemory.id, 'applied', 'Set to Auto: 512 MiB reserved')]) }));
      render(<Recommendations />);
      await screen.findByRole('heading', { name: displayMemory.title });
      const memory = card(displayMemory.title);
      expect(row(displayMemory.title, 'spark1').getByText(/^Not a one-click setting/)).toBeInTheDocument();
      expect(memory.getByText(commands(displayMemory.apply))).toBeVisible();
      expect(memory.getByText(commands(displayMemory.undo))).toBeVisible();
      expect(memory.queryByRole('button', { name: /^(Apply|Undo) / })).not.toBeInTheDocument();
    });
  });

  describe('the confirmation', () => {
    it('names the node, the commands, what a reboot does and the risks, and does nothing on Cancel', async () => {
      const { fetchSpy } = serve(view([gpuCap], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      await userEvent.click(await screen.findByRole('button', { name: `Apply ${GPU} on spark2` }));
      const dialog = within(screen.getByRole('dialog', { name: `Apply “${GPU}” on spark2?` }));
      expect(dialog.getByText("Change spark2: Sparkline's root helper on spark2 applies this setting.")).toBeInTheDocument();
      expect(dialog.getByText(commands(gpuCap.apply))).toBeInTheDocument();
      expect(dialog.getByText(BY_HAND_CAP)).toBeInTheDocument();
      expect(dialog.getByText('The setting is forgotten at a reboot, so Sparkline applies it again at every boot until it is undone.')).toBeInTheDocument();
      for (const risk of gpuCap.risks) expect(dialog.getByText(risk)).toBeInTheDocument();
      expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveFocus();

      await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: /Apply/ })).not.toBeInTheDocument();
      expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
    });

    it('lists the undo commands before an undo, and says a persistent change survives a reboot', async () => {
      const { fetchSpy } = serve(view([headless], { spark2: node([item(headless.id, 'applied', 'Boots without the desktop', { managed: true })]) }));
      render(<Recommendations />);
      await userEvent.click(await screen.findByRole('button', { name: `Undo ${headless.title} on spark2` }));
      const dialog = within(screen.getByRole('dialog', { name: `Undo “${headless.title}” on spark2?` }));
      expect(dialog.getByText("Change spark2: Sparkline's root helper on spark2 removes this setting.")).toBeInTheDocument();
      expect(dialog.getByText(commands(headless.undo))).toBeInTheDocument();
      expect(dialog.getByText(BY_HAND_BOOT)).toBeInTheDocument();
      expect(dialog.getByText('The change survives a reboot.')).toBeInTheDocument();

      await userEvent.click(dialog.getByRole('button', { name: 'Undo on spark2' }));
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/recommendations/${headless.id}/undo`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ node: 'spark2', confirm: true }) }));
    });
  });

  describe('after confirming', () => {
    it('posts the confirmed request, shows the row as pending, and settles when the node reports the change', async () => {
      const { answer, fetchSpy } = await openOnSpark2();
      confirmApply();
      await tick();
      expect(fetchSpy).toHaveBeenCalledWith(`/api/v1/recommendations/${gpuCap.id}/apply`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ node: 'spark2', confirm: true }) }));
      expect(screen.queryByRole('dialog', { name: /Apply/ })).not.toBeInTheDocument();
      const pending = row(GPU, 'spark2').getByRole('button', { name: `Applying… ${GPU} on spark2` });
      expect(pending).toHaveTextContent('Applying…');
      expect(pending).toHaveAttribute('aria-disabled', 'true');

      // One second on the node has not changed yet: still pending.
      await tick(1000);
      expect(row(GPU, 'spark2').getByRole('button', { name: `Applying… ${GPU} on spark2` })).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByText('Recommended')).toBeInTheDocument();

      answer.view = view([gpuCap], { spark2: node([applied]) });
      await tick(1000);
      expect(row(GPU, 'spark2').getByText('Applied')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByText('Capped at 2200 MHz by Sparkline')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByRole('button', { name: `Undo ${GPU} on spark2` })).not.toHaveAttribute('aria-disabled');
      expect(card(GPU).getByText('Applied on every node')).toBeInTheDocument();

      // Settled: the one-second poll has stopped.
      const calls = fetchSpy.mock.calls.length;
      await tick(5000);
      expect(fetchSpy.mock.calls.length).toBe(calls);
    });

    it('shows the helper’s failure on the row and offers Apply again', async () => {
      const { answer } = await openOnSpark2();
      confirmApply();
      await tick();
      answer.view = view([gpuCap], { spark2: node([{ ...notApplied, last: { action: 'apply', ts: 300, ok: false, message: 'nvidia-smi -lgc 0,2200 failed with exit 4: not supported' } }]) });
      await tick(1000);
      expect(row(GPU, 'spark2').getByText('Apply failed: nvidia-smi -lgc 0,2200 failed with exit 4: not supported')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByText('Recommended')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByRole('button', { name: `Apply ${GPU} on spark2` })).not.toHaveAttribute('aria-disabled');
    });

    it('does not take an earlier failure for the answer to a new click', async () => {
      const failedBefore = { ...notApplied, last: { action: 'apply', ts: 100, ok: false, message: 'nvidia-smi did not finish within 30 s' } };
      await openOnSpark2(failedBefore);
      expect(row(GPU, 'spark2').getByText('Apply failed: nvidia-smi did not finish within 30 s')).toBeInTheDocument();
      confirmApply();
      await tick(1000);
      expect(row(GPU, 'spark2').getByRole('button', { name: `Applying… ${GPU} on spark2` })).toBeInTheDocument();
    });

    it('shows why the console refused the request', async () => {
      const refused = { message: 'A benchmark is running on spark2', cause: 'Settings do not change during a run', fix: 'Wait for the run to finish, or cancel it' };
      const { fetchSpy } = await openOnSpark2(notApplied, () => json({ problem: refused }, 409));
      confirmApply();
      await tick();
      const alert = within(row(GPU, 'spark2').getByRole('alert'));
      expect(alert.getByText(refused.message)).toBeInTheDocument();
      expect(alert.getByText(refused.cause)).toBeInTheDocument();
      expect(alert.getByText(refused.fix)).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByRole('button', { name: `Apply ${GPU} on spark2` })).not.toHaveAttribute('aria-disabled');
      // Refused: nothing to wait for.
      const calls = fetchSpy.mock.calls.length;
      await tick(3000);
      expect(fetchSpy.mock.calls.length).toBe(calls);
    });

    it('says so when the node reports no change within 30 seconds', async () => {
      await openOnSpark2();
      confirmApply();
      await tick(29_000);
      expect(row(GPU, 'spark2').getByRole('button', { name: `Applying… ${GPU} on spark2` })).toBeInTheDocument();
      await tick(1000);
      expect(within(row(GPU, 'spark2').getByRole('alert')).getByText('spark2 has not reported a change after 30 seconds')).toBeInTheDocument();
      expect(row(GPU, 'spark2').getByRole('button', { name: `Apply ${GPU} on spark2` })).toBeInTheDocument();
    });
  });

  describe('loading, empty and failed', () => {
    it('is busy until the console answers', async () => {
      serve(view([gpuCap], { spark2: node([notApplied]) }));
      render(<Recommendations />);
      expect(screen.getByRole('region', { name: 'Loading…' })).toHaveAttribute('aria-busy', 'true');
      expect(await screen.findByRole('heading', { name: GPU })).toBeInTheDocument();
    });

    it('says when the release ships no recommendations', async () => {
      serve(view([], { spark2: node([]) }));
      render(<Recommendations />);
      expect(await screen.findByText('No recommendations')).toBeInTheDocument();
    });

    it('offers a retry when the recommendations cannot be loaded', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ problem: { message: 'Console restarting', cause: '', fix: '' } }, 503));
      render(<Recommendations />);
      expect(await screen.findByText('Console restarting')).toBeInTheDocument();
      fetchSpy.mockImplementation(() => Promise.resolve(json(view([gpuCap], { spark2: node([notApplied]) }))));
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { name: GPU })).toBeInTheDocument();
    });

    it('refreshes every 15 s and keeps the page when a refresh fails', async () => {
      const { answer, fetchSpy } = await openOnSpark2();
      fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await tick(15_000);
      expect(row(GPU, 'spark2').getByText('Recommended')).toBeInTheDocument();
      answer.view = view([gpuCap], { spark2: node([applied]) });
      await tick(15_000);
      expect(row(GPU, 'spark2').getByText('Applied')).toBeInTheDocument();
    });
  });
});
