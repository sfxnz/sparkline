import { run } from './fixtures';
import { runFrame } from './RunTelemetry';

describe('runFrame', () => {
  it('fits a short finished run with a little context, so a 4 s run is not a sliver of a minute', () => {
    const r = run({ id: 'a', started_ts: 1000, finished_ts: 1004 });
    expect(runFrame(r, 2000, 4, false)).toEqual([995, 1009]);
  });
  it('keeps 30 s of context around long runs, and a 10 % margin for saved series', () => {
    const r = run({ id: 'b', started_ts: 1000, finished_ts: 1300 });
    expect(runFrame(r, 2000, 300, false)).toEqual([970, 1330]);
    expect(runFrame(r, 2000, 300, true)).toEqual([970, 1330]);
    expect(runFrame(run({ id: 'c', started_ts: 1000, finished_ts: 1004 }), 2000, 4, true)).toEqual([998, 1006]);
  });
});
