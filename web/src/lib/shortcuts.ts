// Global keyboard shortcuts. Bindings are space-separated key sequences ("g o"), single keys ("?", "1"),
// or "mod+k" (⌘ on Apple platforms, Ctrl elsewhere). Plain-key shortcuts are ignored while typing.

export interface Binding {
  keys: string;
  run: (ev: KeyboardEvent) => void;
  /** Also fire while focus is in a text field (only used for mod+k). */
  allowInInputs?: boolean;
}

export const isApple = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type);
}

function chord(ev: KeyboardEvent, apple: boolean): string | null {
  const mod = apple ? ev.metaKey : ev.ctrlKey;
  if (mod && !ev.altKey) return `mod+${ev.key.toLowerCase()}`;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  return ev.key.length === 1 || ev.key === 'Escape' ? ev.key : null;
}

/**
 * Create a keydown handler for the given bindings. Sequences must be completed within `timeoutMs`.
 * `singleKeys` is read on every key: when it returns false, only modifier chords (mod+k) fire.
 */
export function createShortcutHandler(
  bindings: readonly Binding[],
  {
    timeoutMs = 1200,
    apple = isApple(),
    now = () => Date.now(),
    singleKeys = (): boolean => true,
  }: { timeoutMs?: number; apple?: boolean; now?: () => number; singleKeys?: () => boolean } = {},
): (ev: KeyboardEvent) => void {
  let buffer: string[] = [];
  let lastAt = 0;
  const fire = (b: Binding, ev: KeyboardEvent) => {
    ev.preventDefault();
    buffer = [];
    b.run(ev);
  };
  return (ev) => {
    if (ev.defaultPrevented || ev.isComposing) return;
    const key = chord(ev, apple);
    if (!key) return;
    if (!key.startsWith('mod+') && !singleKeys()) return;
    if (isTypingTarget(ev.target)) {
      const b = bindings.find((x) => x.allowInInputs && x.keys === key);
      if (b) fire(b, ev);
      return;
    }
    if (now() - lastAt > timeoutMs) buffer = [];
    lastAt = now();
    buffer.push(key);
    let seq = buffer.join(' ');
    const live = (s: string) => bindings.some((b) => b.keys === s || b.keys.startsWith(`${s} `));
    if (!live(seq)) {
      buffer = [key]; // abandon a broken sequence, but let this key start or match on its own
      seq = key;
    }
    const exact = bindings.find((b) => b.keys === seq);
    if (exact) fire(exact, ev);
    else if (!live(seq)) buffer = [];
  };
}
