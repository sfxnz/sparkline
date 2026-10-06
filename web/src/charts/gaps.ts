// Break chart lines across outages. Neither the live ring nor history has points while a node is down, so without
// a null in the gap uPlot would draw a straight line from the last value before the outage to the first after it.

/** Median spacing of a sorted timestamp array (0 when fewer than two points). */
export function medianStep(ts: ArrayLike<number>): number {
  if (ts.length < 2) return 0;
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) d.push((ts[i] ?? 0) - (ts[i - 1] ?? 0));
  d.sort((a, b) => a - b);
  return d[d.length >> 1] ?? 0;
}

/**
 * Insert one null point into every series wherever consecutive timestamps are more than `factor` typical steps
 * apart (the step being `step`, or the median spacing). Returns the inputs unchanged when there is no gap.
 */
export function insertGaps(ts: number[], values: (number | null)[][], step?: number, factor = 2.5): { ts: number[]; values: (number | null)[][] } {
  const s = step && step > 0 ? step : medianStep(ts);
  if (!s || ts.length < 2) return { ts, values };
  const max = s * factor;
  let gaps = 0;
  for (let i = 1; i < ts.length; i++) if ((ts[i] ?? 0) - (ts[i - 1] ?? 0) > max) gaps++;
  if (!gaps) return { ts, values };
  const outTs: number[] = [];
  const out = values.map(() => [] as (number | null)[]);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? 0;
    const prev = ts[i - 1];
    if (prev !== undefined && t - prev > max) {
      outTs.push((prev + t) / 2);
      for (const o of out) o.push(null);
    }
    outTs.push(t);
    values.forEach((v, k) => (out[k] as (number | null)[]).push(v[i] ?? null));
  }
  return { ts: outTs, values: out };
}
