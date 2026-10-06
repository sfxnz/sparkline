import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import './Table.css';

export interface Column<T> {
  id: string;
  header: string;
  /** Cell content; defaults to String(sortValue). */
  render?: (row: T) => ReactNode;
  /** Enables sorting on this column. null sorts last. */
  sortValue?: (row: T) => number | string | null;
  align?: 'start' | 'end';
  width?: string;
}

interface Props<T> {
  caption: string;
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  /** Show the caption visually (otherwise it is screen-reader only). */
  showCaption?: boolean;
  maxHeight?: number | string;
  empty?: ReactNode;
}

type Sort = { id: string; dir: 'asc' | 'desc' } | null;

export function sortRows<T>(rows: readonly T[], get: (row: T) => number | string | null, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign;
  });
}

/** Sortable table: header buttons, aria-sort, sticky header, tabular numbers. */
export function Table<T>({ caption, columns, rows, rowKey, initialSort, showCaption, maxHeight, empty }: Props<T>) {
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.id === sort.id);
    return col?.sortValue && sort ? sortRows(rows, col.sortValue, sort.dir) : rows;
  }, [rows, columns, sort]);

  const toggle = (c: Column<T>) => {
    setSort((s) => {
      if (s?.id !== c.id) return { id: c.id, dir: c.align === 'end' ? 'desc' : 'asc' };
      return { id: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <div className="table-wrap" style={{ maxHeight }}>
      <table className="table">
        <caption className={showCaption ? 'table__caption' : 'visually-hidden'}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.id === c.id;
              const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined;
              const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
              return (
                <th key={c.id} scope="col" aria-sort={ariaSort} className={c.align === 'end' ? 'is-end' : undefined} style={{ width: c.width }}>
                  {c.sortValue ? (
                    <button type="button" className={`table__sort${active ? ' is-active' : ''}`} onClick={() => { toggle(c); }}>
                      <span>{c.header}</span>
                      <Icon aria-hidden="true" />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && empty ? (
            <tr>
              <td colSpan={columns.length} className="table__empty">{empty}</td>
            </tr>
          ) : (
            sorted.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => (
                  <td key={c.id} className={c.align === 'end' ? 'is-end' : undefined}>
                    {c.render ? c.render(r) : String(c.sortValue?.(r) ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
