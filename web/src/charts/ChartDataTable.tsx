import { formatClock } from '../lib/format';
import '../design/components/Table.css';

export interface TableSeries {
  label: string;
  values: readonly (number | null)[];
}

/** Bucket-average rows down to at most `maxRows` (nulls ignored; an all-null bucket stays null). */
export function downsampleRows(ts: readonly number[], series: readonly TableSeries[], maxRows: number) {
  const n = ts.length;
  const buckets = Math.min(n, Math.max(1, maxRows));
  const rows: { ts: number; values: (number | null)[] }[] = [];
  if (!n) return rows;
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * n) / buckets);
    const hi = Math.max(lo + 1, Math.floor(((b + 1) * n) / buckets));
    const values = series.map((s) => {
      let sum = 0;
      let count = 0;
      for (let i = lo; i < hi; i++) {
        const v = s.values[i];
        if (v != null && !Number.isNaN(v)) {
          sum += v;
          count++;
        }
      }
      return count ? sum / count : null;
    });
    rows.push({ ts: ts[hi - 1] ?? 0, values });
  }
  return rows;
}

interface Props {
  id?: string;
  caption: string;
  ts: readonly number[];
  series: readonly TableSeries[];
  format: (n: number) => string;
  maxRows?: number;
}

/** Accessible alternative to a chart: the visible range as a table, downsampled to <= maxRows rows. */
export function ChartDataTable({ id, caption, ts, series, format, maxRows = 60 }: Props) {
  const rows = downsampleRows(ts, series, maxRows);
  return (
    <div className="table-wrap chart-table" id={id} style={{ maxHeight: 280 }}>
      <table className="table">
        <caption className="table__caption">
          {caption}
          {ts.length > rows.length ? ` (${rows.length} averaged rows from ${ts.length} samples)` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {series.map((s) => (
              <th scope="col" key={s.label} className="is-end">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={series.length + 1} className="table__empty">No data in this range</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.ts}>
                <th scope="row">
                  <time dateTime={new Date(r.ts * 1000).toISOString()}>{formatClock(r.ts)}</time>
                </th>
                {r.values.map((v, i) => (
                  <td key={series[i]?.label ?? i} className="is-end">{v === null ? '—' : format(v)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
