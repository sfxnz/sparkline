import { render } from '@testing-library/react';

// Motion reads requestAnimationFrame when its frame loop module loads, so the counting clock goes in before any
// import that reaches motion (hence the dynamic imports below).
let requested = 0;
let lastRequest = 0;
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  requested++;
  lastRequest = performance.now();
  return window.setTimeout(() => {
    cb(performance.now());
  }, 16);
});
vi.stubGlobal('cancelAnimationFrame', (id: number) => {
  window.clearTimeout(id);
});

const { AnimatedNumber } = await import('./AnimatedNumber');
await import('../animate');
await new Promise((r) => setTimeout(r, 0));

const GiB = 1024 ** 3;
const gib = (n: number) => (n / GiB).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textsOf(el: HTMLElement): string[] {
  const seen: string[] = [];
  new MutationObserver(() => seen.push(el.textContent)).observe(el, { characterData: true, childList: true, subtree: true });
  return seen;
}

describe('AnimatedNumber frame loop', () => {
  beforeEach(() => {
    requested = 0;
  });

  it('requests no frames when the new value shows the same text', async () => {
    const { container, rerender } = render(<AnimatedNumber value={30.01 * GiB} format={gib} />);
    rerender(<AnimatedNumber value={30.02 * GiB} format={gib} />);
    await sleep(100);
    expect(container.textContent).toBe('30.0');
    expect(requested).toBe(0);
  });

  it('animates a visible change of a byte value and stops requesting frames once it settles', async () => {
    const { container, rerender } = render(<AnimatedNumber value={30 * GiB} format={gib} />);
    const seen = textsOf(container.firstElementChild as HTMLElement);
    const start = performance.now();
    rerender(<AnimatedNumber value={31 * GiB} format={gib} />);
    await sleep(1500);
    expect(container.textContent).toBe('31.0');
    expect(seen.some((t) => Number(t) > 30 && Number(t) < 31)).toBe(true);
    expect(lastRequest - start).toBeLessThan(600);
  });
});
