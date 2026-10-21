// The scenario board: every scenario of the run as a small tile, grouped by category (A to P) with each category's
// score so far. Tiles are buttons with a tooltip (title, verdict, the evaluator's summary); a finished one opens the
// scenario dialog. The whole board is one tab stop: arrow keys move between tiles (up and down jump category).
import { memo, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Skeleton } from '../../../design/components/Skeleton';
import { Tooltip } from '../../../design/components/Tooltip';
import { formatSeconds, isOutcome, scenarioNumber, STATUS_LOOK, type BoardGroup, type Tile } from './model';
import { CategoryTag, StatusGlyph } from './parts';

interface Props {
  groups: readonly BoardGroup[];
  /** The evaluator's summary per finished scenario, for the tooltips. */
  summaries: ReadonlyMap<string, string>;
  onOpen: (id: string) => void;
  /** The scenario that finished last (its tile settles in with a small pop). */
  latest?: string;
  /** Lay categories out in two columns when there is room (the board is the page's width). */
  wide?: boolean;
  label: string;
}

export function Board({ groups, summaries, onOpen, latest, wide, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const hint = useId();
  const [stop, setStop] = useState<string | null>(null);
  const ids = useMemo(() => groups.flatMap((g) => g.tiles.map((t) => t.id)), [groups]);
  const tabStop = stop !== null && ids.includes(stop) ? stop : ids[0];

  const focus = (id: string | undefined) => {
    if (id) ref.current?.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const id = e.target instanceof HTMLElement ? e.target.dataset.id : undefined;
    const gi = groups.findIndex((g) => g.tiles.some((t) => t.id === id));
    const group = groups[gi];
    if (!id || !group) return;
    const ti = group.tiles.findIndex((t) => t.id === id);
    const i = ids.indexOf(id);
    const vertical = (d: number) => {
      const g = groups[gi + d];
      return g ? g.tiles[Math.min(ti, g.tiles.length - 1)]?.id : undefined;
    };
    const next =
      e.key === 'ArrowRight' ? ids[i + 1]
      : e.key === 'ArrowLeft' ? ids[i - 1]
      : e.key === 'ArrowDown' ? vertical(1)
      : e.key === 'ArrowUp' ? vertical(-1)
      : e.key === 'Home' ? ids[0]
      : e.key === 'End' ? ids.at(-1)
      : null;
    if (next === null) return;
    e.preventDefault();
    focus(next);
  };
  const onFocus = (e: FocusEvent) => {
    const id = e.target instanceof HTMLElement ? e.target.dataset.id : undefined;
    if (id) setStop(id);
  };

  return (
    // Keyboard handling for the tiles inside (each is a focusable button); the group only routes arrow keys.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div ref={ref} className={`te-board${wide ? ' te-board--wide' : ''}`} role="group" aria-label={label} aria-describedby={hint} onKeyDown={onKeyDown} onFocus={onFocus}>
      <p id={hint} className="visually-hidden">Arrow keys move between scenarios; Enter opens a finished one.</p>
      {groups.map((g) => (
        <div key={g.cat} className="te-cat" role="group" aria-label={`${g.cat} · ${g.label || 'Other'}: ${g.percent === null ? '' : `${g.percent}%, `}${g.done} of ${g.tiles.length} done`}>
          <div className="te-cat__head" aria-hidden="true">
            <CategoryTag cat={g.cat} />
            <span className="te-cat__label">{g.label || 'Other'}</span>
            <span className="te-cat__meta num">
              {g.percent === null ? '' : <strong>{g.percent}%</strong>}
              {g.percent === null ? '' : ' · '}
              {g.done} of {g.tiles.length}
            </span>
          </div>
          <ul className="te-tiles">
            {g.tiles.map((t) => (
              <BoardTile key={t.id} tile={t} summary={summaries.get(t.id) ?? ''} tabStop={t.id === tabStop} latest={t.id === latest} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** "01" for TC-01; ids without a number are shown whole. */
function shortId(id: string): string {
  const n = scenarioNumber(id);
  return n === Number.MAX_SAFE_INTEGER ? id : String(n).padStart(2, '0');
}

interface TileProps {
  tile: Tile;
  summary: string;
  tabStop: boolean;
  latest: boolean;
  onOpen: (id: string) => void;
}

/** Every snapshot re-creates the tiles; one re-renders only when what it shows changed (2 updates/s × 97 tiles). */
const sameTile = (a: TileProps, b: TileProps) =>
  a.summary === b.summary && a.tabStop === b.tabStop && a.latest === b.latest && a.onOpen === b.onOpen &&
  a.tile.id === b.tile.id && a.tile.status === b.tile.status && a.tile.points === b.tile.points && a.tile.s === b.tile.s && a.tile.title === b.tile.title;

const BoardTile = memo(function BoardTile({ tile, summary, tabStop, latest, onOpen }: TileProps) {
  const look = STATUS_LOOK[tile.status];
  const finished = isOutcome(tile.status);
  return (
    <li>
      <Tooltip content={<TileTip tile={tile} summary={summary} />}>
        <button
          type="button"
          data-id={tile.id}
          className={`te-tile is-${tile.status}${look.tone ? ` tone-${look.tone}` : ''}${latest ? ' is-latest' : ''}`}
          tabIndex={tabStop ? 0 : -1}
          aria-label={`${tile.id}, ${look.label.toLowerCase()}`}
          aria-disabled={finished ? undefined : true}
          onClick={finished ? () => { onOpen(tile.id); } : undefined}
        >
          <span className="te-tile__num">{shortId(tile.id)}</span>
          <StatusGlyph status={tile.status} />
        </button>
      </Tooltip>
    </li>
  );
}, sameTile);

function TileTip({ tile, summary }: { tile: Tile; summary: string }) {
  const look = STATUS_LOOK[tile.status];
  const facts = isOutcome(tile.status)
    ? [look.label, tile.status === 'excluded' || tile.points === null ? '' : `${tile.points} of 2 points`, tile.s === null ? '' : formatSeconds(tile.s)]
    : [look.label];
  return (
    <span className="te-tip">
      <span className="te-tip__title">{tile.title ? `${tile.id} · ${tile.title}` : tile.id}</span>
      <span className="te-tip__facts">{facts.filter(Boolean).join(' · ')}</span>
      {summary ? <span className="te-tip__summary">{summary.length > 180 ? `${summary.slice(0, 179)}…` : summary}</span> : null}
    </span>
  );
}

/** The board's shape before the first snapshot: the suite's categories and tile counts, shimmering. */
export function BoardSkeleton({ shape }: { shape: readonly number[] }) {
  return (
    <div className="te-board" aria-hidden="true">
      {shape.map((n, i) => (
        <div key={i} className="te-cat">
          <div className="te-cat__head">
            <Skeleton width="1.375rem" height="1.375rem" radius={6} />
            <Skeleton width={i % 3 === 0 ? 120 : i % 3 === 1 ? 96 : 136} height={12} />
            <Skeleton width={52} height={10} className="te-cat__meta" />
          </div>
          <ul className="te-tiles">
            {Array.from({ length: n }, (_, j) => <li key={j}><Skeleton width="2.75rem" height="1.625rem" radius={7} /></li>)}
          </ul>
        </div>
      ))}
    </div>
  );
}
