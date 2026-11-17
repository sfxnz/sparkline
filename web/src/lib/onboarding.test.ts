import { agentAddress, fixCommands, fixSteps, guideStage, guideView, isNewNode, mergeOnboarding, needsSetup, reachOf, retryWait } from './onboarding';
import type { Onboarding } from './types';

const ob = (over: Partial<Onboarding> = {}): Onboarding => ({ started: 100, finished: null, seen: [], ...over });

describe('new nodes', () => {
  it('a node is new only while the console says it has never answered', () => {
    expect(isNewNode({ first_seen: null })).toBe(true);
    expect(isNewNode({ first_seen: 1_700_000_000 })).toBe(false);
    // A console before 0.3.0 sends no first_seen: its nodes were set up long ago.
    expect(isNewNode({})).toBe(false);
    expect(isNewNode(undefined)).toBe(false);
  });

  it('a new node needs setup once the console has tried it and failed', () => {
    expect(needsSetup({ first_seen: null, status: 'offline' })).toBe(true);
    expect(needsSetup({ first_seen: null, status: 'error' })).toBe(true);
    expect(needsSetup({ first_seen: null, status: 'connecting' })).toBe(false);
    expect(needsSetup({ first_seen: 5, status: 'offline' })).toBe(false);
  });
});

describe('mergeOnboarding', () => {
  it('adds seen ids as a sorted set, and the same patch twice gives the same row', () => {
    const once = mergeOnboarding(ob({ seen: ['prometheus'] }), { seen: ['benchmarks', 'prometheus'] }, 200);
    expect(once.seen).toEqual(['benchmarks', 'prometheus']);
    expect(mergeOnboarding(once, { seen: ['benchmarks', 'prometheus'] }, 300)).toEqual(once);
  });

  it('stamps finished once, and false clears it', () => {
    const done = mergeOnboarding(ob(), { finished: true }, 200);
    expect(done.finished).toBe(200);
    expect(mergeOnboarding(done, { finished: true }, 300).finished).toBe(200);
    expect(mergeOnboarding(done, { finished: false }, 300).finished).toBeNull();
    expect(mergeOnboarding(done, { seen: ['x'] }, 300).finished).toBe(200);
  });
});

describe('the guide follows the console state', () => {
  it('is finished for an older console, before anyone signed in, and once completed or dismissed', () => {
    expect(guideStage(null)).toBe('finished');
    expect(guideStage(undefined)).toBe('finished');
    expect(guideStage(ob({ started: null }))).toBe('finished');
    expect(guideStage(ob({ finished: 150 }))).toBe('finished');
  });

  it('is a first visit until an item was opened, then resumed', () => {
    expect(guideStage(ob())).toBe('first');
    expect(guideStage(ob({ seen: ['prometheus'] }))).toBe('resumed');
  });

  it('draws the full panel first, one line when resumed, and nothing once finished', () => {
    expect(guideView('first', null)).toBe('full');
    expect(guideView('resumed', null)).toBe('strip');
    expect(guideView('finished', null)).toBe('gone');
  });

  it("this browser's Collapse and Show all win while the guide is unfinished, and never bring a finished one back", () => {
    expect(guideView('first', false)).toBe('strip');
    expect(guideView('resumed', true)).toBe('full');
    expect(guideView('finished', true)).toBe('gone');
  });
});

describe('a node that cannot be reached', () => {
  it('names the address the console tried', () => {
    expect(agentAddress('http://192.168.1.11:9750')).toBe('192.168.1.11:9750');
    expect(agentAddress('https://spark2.example')).toBe('spark2.example');
    expect(agentAddress('not a url')).toBe('not a url');
  });

  it('finds every command a fix names, once each, in order', () => {
    expect(fixCommands('Check `systemctl status sparkline-agent` on spark1')).toEqual(['systemctl status sparkline-agent']);
    expect(fixCommands('Check `journalctl -u sparkline-agent` on spark1 and `systemctl status sparkline-agent`; then `journalctl -u sparkline-agent` again'))
      .toEqual(['journalctl -u sparkline-agent', 'systemctl status sparkline-agent']);
    expect(fixCommands(null)).toEqual([]);
  });

  it('takes a span of several words for a command, and a key or a path for a name', () => {
    expect(fixCommands('`agent_token` in `/etc/sparkline/console.toml` must equal `token`. Run `sudo grep token /etc/sparkline/*.toml`.')).toEqual(['sudo grep token /etc/sparkline/*.toml']);
  });

  it('reads a fix as its steps, one per sentence, each with the commands it names', () => {
    const fix = 'Start the agent on spark1: `sudo systemctl start sparkline-agent`. If it does not stay up, `journalctl -u sparkline-agent -n 50` says why. '
      + 'If the agent was never installed on spark1, run `sudo ./install.sh agent` in the Sparkline folder there.';
    expect(fixSteps(fix)).toEqual([
      { text: 'Start the agent on spark1: `sudo systemctl start sparkline-agent`.', commands: ['sudo systemctl start sparkline-agent'] },
      { text: 'If it does not stay up, `journalctl -u sparkline-agent -n 50` says why.', commands: ['journalctl -u sparkline-agent -n 50'] },
      { text: 'If the agent was never installed on spark1, run `sudo ./install.sh agent` in the Sparkline folder there.', commands: ['sudo ./install.sh agent'] },
    ]);
    // A full stop in a path, an address or a command ends nothing; a fix of one sentence is one step, as written.
    expect(fixSteps('Check that 192.168.1.11 is the `url` in `/etc/sparkline/console.toml`. Then run `sudo ./install.sh agent`').map((s) => s.text))
      .toEqual(['Check that 192.168.1.11 is the `url` in `/etc/sparkline/console.toml`.', 'Then run `sudo ./install.sh agent`']);
    expect(fixSteps('Check `journalctl -u sparkline-agent` on spark1')).toEqual([{ text: 'Check `journalctl -u sparkline-agent` on spark1', commands: ['journalctl -u sparkline-agent'] }]);
    expect(fixSteps(null)).toEqual([]);
  });

  it('draws an error as an agent that answered and said no, and anything else as no answer', () => {
    expect(reachOf('error')).toBe('turned-away');
    expect(reachOf('offline')).toBe('no-answer');
  });

  it('counts down to the next attempt and says how much of the wait is left', () => {
    expect(retryWait(130, 100, 100)).toEqual({ secs: 30, left: 1 });
    expect(retryWait(130, 100, 115)).toEqual({ secs: 15, left: 0.5 });
    expect(retryWait(130, 100, 129.2)).toMatchObject({ secs: 1 });
    expect(retryWait(130, 100, 130)).toEqual({ secs: 0, left: 0 });
    expect(retryWait(null, 100, 100)).toEqual({ secs: 0, left: 0 });
    // Learned after a reload, part way through the wait: the bar starts full and still ends on time.
    expect(retryWait(130, 120, 125)).toEqual({ secs: 5, left: 0.5 });
  });
});
