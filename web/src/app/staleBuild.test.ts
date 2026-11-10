import { reloadOnStaleBuild } from './staleBuild';

const chunkFailed = () => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));

describe('reloadOnStaleBuild', () => {
  const reload = vi.fn();
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    reload.mockClear();
    stop = reloadOnStaleBuild(reload);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it('reloads onto the new build when a lazy chunk fails in a tab open since before an update', () => {
    vi.advanceTimersByTime(30 * 60_000);
    chunkFailed();
    expect(reload).toHaveBeenCalled();
  });

  it('leaves a failure on a page loaded seconds ago, such as right after that reload, to the error UI', () => {
    vi.advanceTimersByTime(3_000);
    chunkFailed();
    expect(reload).not.toHaveBeenCalled();
  });
});
