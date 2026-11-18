import { agentAddress, fixSteps, guideStage, guideView, isNewNode, mergeOnboarding, needsSetup, reachOf, retryWait } from './onboarding';
import type { Onboarding } from './types';

const ob = (over: Partial<Onboarding> = {}): Onboarding => ({ started: 100, finished: null, reopened: false, seen: [], ...over });

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

  it('a guide cleared after it was finished is reopened, until it is finished again', () => {
    const back = mergeOnboarding(ob({ finished: 200 }), { finished: false }, 300);
    expect(back).toMatchObject({ finished: null, reopened: true });
    expect(mergeOnboarding(back, { seen: ['x'] }, 400).reopened).toBe(true);
    expect(mergeOnboarding(back, { finished: true }, 400)).toMatchObject({ finished: 400, reopened: false });
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
    expect(guideView(ob(), null)).toBe('full');
    expect(guideView(ob({ seen: ['prometheus'] }), null)).toBe('strip');
    expect(guideView(ob({ finished: 200 }), null)).toBe('gone');
  });

  it('draws a guide that was brought back in full, in a browser that did not ask for it too', () => {
    expect(guideView(ob({ seen: ['prometheus'], reopened: true }), null)).toBe('full');
    expect(guideView(ob({ seen: ['prometheus'], reopened: true }), false)).toBe('strip');
  });

  it("this browser's Collapse and Show all win while the guide is unfinished, and never bring a finished one back", () => {
    expect(guideView(ob(), false)).toBe('strip');
    expect(guideView(ob({ seen: ['prometheus'] }), true)).toBe('full');
    expect(guideView(ob({ finished: 200 }), true)).toBe('gone');
  });
});

describe('a node that cannot be reached', () => {
  it('names the address the console tried', () => {
    expect(agentAddress('http://192.168.1.11:9750')).toBe('192.168.1.11:9750');
    expect(agentAddress('https://spark2.example')).toBe('spark2.example');
    expect(agentAddress('not a url')).toBe('not a url');
  });

  it('reads a fix as its steps: the words of each, and the command it ends in', () => {
    const fix = 'Start the agent on spark1: `sudo systemctl start sparkline-agent`. If it does not stay up, read why: `journalctl -u sparkline-agent -n 50`. '
      + 'If the agent was never installed on spark1, install it from the Sparkline folder there: `sudo ./install.sh agent`.';
    expect(fixSteps(fix)).toEqual([
      { text: 'Start the agent on spark1:', command: 'sudo systemctl start sparkline-agent' },
      { text: 'If it does not stay up, read why:', command: 'journalctl -u sparkline-agent -n 50' },
      { text: 'If the agent was never installed on spark1, install it from the Sparkline folder there:', command: 'sudo ./install.sh agent' },
    ]);
    // No step says its command twice: the words never hold it.
    for (const step of fixSteps(fix)) expect(step.text).not.toContain('`');
  });

  it('keeps a key or a path in the words, and a step with nothing to run whole', () => {
    const fix = '`agent_token` in `/etc/sparkline/console.toml` must equal `token` in `/etc/sparkline/agent.toml` on spark1. '
      + 'See both, on the console host and on spark1: `sudo grep token /etc/sparkline/*.toml`. Edit one file so they match, then restart its service. '
      + 'For the console: `sudo systemctl restart sparkline`.';
    expect(fixSteps(fix)).toEqual([
      { text: '`agent_token` in `/etc/sparkline/console.toml` must equal `token` in `/etc/sparkline/agent.toml` on spark1.', command: null },
      { text: 'See both, on the console host and on spark1:', command: 'sudo grep token /etc/sparkline/*.toml' },
      { text: 'Edit one file so they match, then restart its service.', command: null },
      { text: 'For the console:', command: 'sudo systemctl restart sparkline' },
    ]);
    // A full stop in a path, an address or a command ends nothing; a fix of one sentence is one step, as written.
    expect(fixSteps('Check that 192.168.1.11 is the `url` in `/etc/sparkline/console.toml`. Then check the firewall').map((s) => s.text))
      .toEqual(['Check that 192.168.1.11 is the `url` in `/etc/sparkline/console.toml`.', 'Then check the firewall']);
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
