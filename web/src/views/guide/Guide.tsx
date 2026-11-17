// Getting started, on the overview under the node grid. Three shapes, all from the console's Onboarding (see
// lib/onboarding.ts): every row on a first visit, one line once the person has opened something, and nothing once
// it is finished. The rows come from items.ts.
import { ArrowDown, ArrowRight, Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, type CSSProperties } from 'react';
import { Link } from 'wouter';
import { Button, IconButton } from '../../design/components/Button';
import { InlineCode } from '../../design/components/InlineCode';
import { Kbd } from '../../design/components/Kbd';
import { bringIntoView } from '../../design/useHashTarget';
import { needsSetup } from '../../lib/onboarding';
import { isApple } from '../../lib/shortcuts';
import { useCluster } from '../../store/cluster';
import { finishGuide, markGuideItem, reopenGuide, setGuideOpen, wantGuide } from '../../store/guide';
import { useUi } from '../../store/ui';
import type { Guide as GuideData, GuideItem, GuideRow } from './items';
import { useGuide } from './useGuide';
import './guide.css';

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const countWord = (n: number) => COUNT[n] ?? String(n);

export function GuideRing({ done, total, size = 22, stroke = 3.5 }: { done: number; total: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="guide-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="guide-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle className="guide-ring__value" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (total ? done / total : 0))} />
    </svg>
  );
}

function Meter({ guide }: { guide: GuideData }) {
  return (
    <span className="guide-meter" role="img" aria-label={`${guide.done} of ${guide.total} done`}>
      <span className="guide-meter__segs" aria-hidden="true">
        {guide.rows.map((r, i) => <i key={r.item.id} className={i < guide.done ? 'is-on' : undefined} />)}
      </span>
      <span className="num">{guide.done} of {guide.total}</span>
    </span>
  );
}

function Tile({ row }: { row: GuideRow }) {
  const { item } = row;
  const Icon = row.done ? Check : item.icon;
  const className = `guide-tile${row.done ? ' is-done' : ''}`;
  const body = (
    <>
      <span className="guide-tile__icon" aria-hidden="true"><Icon strokeWidth={row.done ? 2.5 : 2} /></span>
      <span className="guide-tile__text">
        <span className="guide-tile__title">
          <span>{item.title}{row.done ? <span className="visually-hidden"> (done)</span> : null}</span>
          {row.tag ? <span className="guide-tag">{row.tag}</span> : null}
          {row.to ? <ArrowRight className="guide-tile__go" aria-hidden="true" /> : null}
        </span>
        <span className="guide-tile__blurb"><InlineCode text={row.blurb} /></span>
      </span>
    </>
  );
  return (
    <li>
      {/* A row with nowhere to go is a line of the list, not a link that does nothing. */}
      {row.to ? <Link href={row.to} className={className} onClick={() => { void markGuideItem(item.id); }}>{body}</Link> : <div className={className}>{body}</div>}
    </li>
  );
}

function lead(guide: GuideData, stuck: string | undefined): string {
  if (stuck) return `It starts with ${stuck}. The rest opens the real pages, in any order.`;
  return `${countWord(guide.total)} things Sparkline does. Each one opens the real page, in any order.`;
}

export function Guide({ items }: { items?: readonly GuideItem[] }) {
  const { stage, view, guide, ready } = useGuide(items);
  const left = useUi((s) => s.guideLeft);
  const wanted = useUi((s) => s.guideWanted);
  const stuck = useCluster((s) => s.order.find((id) => needsSetup(s.nodes[id])));
  const root = useRef<HTMLElement>(null);

  // Asked for from the sidebar, Settings or the palette: come into view and take focus, once.
  // A frame later: whatever asked (a dialog closing, a page change) has finished moving focus and scroll by then.
  const held = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!wanted || !root.current) return;
    const frame = requestAnimationFrame(() => {
      useUi.setState({ guideWanted: false });
      if (!root.current) return;
      held.current?.();
      held.current = bringIntoView(root.current, 'nearest');
      // "Bring it back" has already handed focus to a control inside (below): leave it there.
      if (!root.current.contains(document.activeElement)) root.current.focus({ preventScroll: true });
    });
    return () => { cancelAnimationFrame(frame); };
  }, [wanted, view]);
  useEffect(() => () => { held.current?.(); }, []);

  // A control that goes away when it is pressed hands the keyboard to its counterpart, so focus never falls to
  // <body>: Collapse to "Show all", Dismiss to "Bring it back", and those two to the first control of the guide in
  // full. The counterpart is focused in the render that first has it.
  const handTo = useRef<'collapse' | 'show-all' | 'bring-back' | null>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  const showAll = useRef<HTMLButtonElement>(null);
  const bringBack = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const to = handTo.current === 'collapse' ? collapse.current : handTo.current === 'show-all' ? showAll.current : handTo.current === 'bring-back' ? bringBack.current : null;
    if (!to) return;
    handTo.current = null;
    to.focus();
  });

  const complete = stage !== 'finished' && ready && guide.total > 0 && guide.done === guide.total;
  useEffect(() => {
    if (complete) void finishGuide('complete');
  }, [complete]);

  // The line that says where the guide went lasts while this page is open, never across a visit.
  useEffect(() => () => { useUi.setState({ guideLeft: null }); }, []);

  if (view === 'gone') {
    if (!left) return null;
    return (
      <div className="guide-gone" role="status">
        <span>
          {left === 'complete' ? 'That is all of it. Getting started is put away.' : 'Getting started is put away.'} It stays in Settings and in Search
          <span className="guide-gone__keys"> (<Kbd>{isApple() ? '⌘' : 'Ctrl'}</Kbd> <Kbd>K</Kbd>)</span>.
        </span>
        {left === 'dismissed' ? <Button ref={bringBack} size="sm" variant="ghost" onClick={() => { handTo.current = 'collapse'; void reopenGuide(); }}>Bring it back</Button> : null}
      </div>
    );
  }

  const dismiss = (
    <IconButton size="sm" aria-label="Dismiss getting started" title="Dismiss" icon={<X />} onClick={() => { handTo.current = 'bring-back'; void finishGuide('dismissed'); }} />
  );

  if (view === 'strip') {
    const next = guide.next;
    return (
      <section ref={root} className="guide-strip material-thin" id="getting-started" aria-label={`Getting started, ${guide.done} of ${guide.total} done`} tabIndex={-1}>
        <span className="guide-strip__id">
          <GuideRing done={guide.done} total={guide.total} />
          <h2 className="guide-strip__title">Getting started</h2>
          <span className="guide-strip__count num">{guide.done} of {guide.total}</span>
        </span>
        {next?.to ? (
          <>
            <span className="guide-strip__rule" aria-hidden="true" />
            <Link href={next.to} className="guide-strip__next" onClick={() => { void markGuideItem(next.item.id); }}>
              <span className="guide-strip__next-label">Next</span>
              <span className="guide-strip__next-title">{next.item.title}</span>
              <span className="guide-strip__next-blurb"><InlineCode text={next.blurb} /></span>
              <ArrowRight aria-hidden="true" />
            </Link>
          </>
        ) : null}
        <span className="guide-strip__actions">
          <Button ref={showAll} size="sm" variant="ghost" className="guide-strip__all" aria-expanded={false} aria-label="Show all" onClick={() => { handTo.current = 'collapse'; setGuideOpen(true); }}>
            <span className="guide-strip__all-label">Show all</span><span className="btn__icon" aria-hidden="true"><ChevronDown /></span>
          </Button>
          {dismiss}
        </span>
      </section>
    );
  }

  return (
    <section ref={root} className="panel material-thin guide" id="getting-started" aria-labelledby="guide-title" tabIndex={-1}>
      <header className="guide__head">
        <div className="guide__titles">
          <h2 className="panel__title" id="guide-title">Getting started</h2>
          <p className="panel__subtitle">{lead(guide, stuck)}</p>
        </div>
        <div className="guide__right">
          <Meter guide={guide} />
          <div className="guide__actions">
            <Button ref={collapse} size="sm" variant="ghost" icon={<ChevronUp />} aria-expanded onClick={() => { handTo.current = 'show-all'; setGuideOpen(false); }}>
              <span className="guide__collapse-label">Collapse</span>
            </Button>
            {dismiss}
          </div>
        </div>
      </header>
      <div className="guide__groups" style={{ '--guide-rows': Math.max(...guide.sections.map((s) => s.rows.length)) } as CSSProperties}>
        {guide.sections.map((s) => (
          <section key={s.id} className="guide-group" aria-labelledby={`guide-group-${s.id}`}>
            <h3 className="guide-group__label" id={`guide-group-${s.id}`}>{s.label}</h3>
            <ul className="guide-group__rows">{s.rows.map((r) => <Tile key={r.item.id} row={r} />)}</ul>
          </section>
        ))}
      </div>
    </section>
  );
}

export function GuideEntry({ collapsed }: { collapsed: boolean }) {
  const { stage, guide } = useGuide();
  if (stage === 'finished') return null;
  return (
    <Link href="/" className="nav__item guide-entry" onClick={wantGuide} title={collapsed ? `Get started, ${guide.done} of ${guide.total} done` : undefined}>
      <GuideRing done={guide.done} total={guide.total} size={18} stroke={3} />
      <span className="nav__label">Get started</span>
      <span className="guide-entry__count num">{guide.done} of {guide.total}<span className="visually-hidden"> done</span></span>
    </Link>
  );
}

/** On a phone the guide is below the node cards: one chip under the welcome says it is there and goes to it. */
export function GuideChip() {
  const { stage, guide } = useGuide();
  if (stage === 'finished') return null;
  return (
    <button type="button" className="guide-chip" onClick={wantGuide}>
      <GuideRing done={guide.done} total={guide.total} size={16} stroke={2.5} />
      <span>Getting started</span>
      <span className="num">{guide.done} of {guide.total}</span>
      <ArrowDown aria-hidden="true" />
    </button>
  );
}
