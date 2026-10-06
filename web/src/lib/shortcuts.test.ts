import { createShortcutHandler, isTypingTarget } from './shortcuts';

function key(k: string, init: KeyboardEventInit = {}, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { key: k, cancelable: true, ...init });
  if (target) Object.defineProperty(ev, 'target', { value: target });
  return ev;
}

describe('shortcuts', () => {
  let t = 0;
  const now = () => t;
  const setup = () => {
    const calls: string[] = [];
    const h = createShortcutHandler(
      [
        { keys: 'g o', run: () => calls.push('overview') },
        { keys: 'g a', run: () => calls.push('alerts') },
        { keys: '?', run: () => calls.push('help') },
        { keys: '1', run: () => calls.push('node1') },
        { keys: 'mod+k', allowInInputs: true, run: () => calls.push('palette') },
      ],
      { apple: false, now, timeoutMs: 1000 },
    );
    return { h, calls };
  };

  it('fires sequences and single keys', () => {
    const { h, calls } = setup();
    h(key('g'));
    h(key('o'));
    h(key('?', { shiftKey: true }));
    h(key('1'));
    expect(calls).toEqual(['overview', 'help', 'node1']);
  });

  it('expires a sequence after the timeout', () => {
    const { h, calls } = setup();
    t = 0;
    h(key('g'));
    t = 1500;
    h(key('o'));
    expect(calls).toEqual([]);
  });

  it('recovers from a broken sequence (g x then 1)', () => {
    const { h, calls } = setup();
    h(key('g'));
    h(key('x'));
    h(key('1'));
    expect(calls).toEqual(['node1']);
  });

  it('ignores plain keys while typing but allows mod+k', () => {
    const { h, calls } = setup();
    const input = document.createElement('input');
    h(key('g', {}, input));
    h(key('o', {}, input));
    h(key('?', {}, input));
    h(key('k', { ctrlKey: true }, input));
    expect(calls).toEqual(['palette']);
  });

  it('ignores keys with modifiers other than mod+k, and prevents default when handled', () => {
    const { h, calls } = setup();
    h(key('1', { altKey: true }));
    h(key('o', { metaKey: true }));
    const ev = key('k', { ctrlKey: true });
    h(ev);
    expect(calls).toEqual(['palette']);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('fires only modifier chords while single-key shortcuts are turned off', () => {
    let enabled = false;
    const calls: string[] = [];
    const h = createShortcutHandler(
      [
        { keys: 'g o', run: () => calls.push('overview') },
        { keys: '1', run: () => calls.push('node1') },
        { keys: 'mod+k', allowInInputs: true, run: () => calls.push('palette') },
      ],
      { apple: false, now, singleKeys: () => enabled },
    );
    const one = key('1');
    h(key('g'));
    h(key('o'));
    h(one);
    h(key('k', { ctrlKey: true }));
    expect(calls).toEqual(['palette']);
    expect(one.defaultPrevented).toBe(false);
    enabled = true;
    h(key('1'));
    expect(calls).toEqual(['palette', 'node1']);
  });

  it('classifies typing targets', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isTypingTarget(text)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});
