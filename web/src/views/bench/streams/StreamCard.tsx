// One concurrent request as a card: slot, state, live tokens/s, the text it is writing (reasoning muted above the
// answer, newest line at the bottom), and tokens against the output limit. A card is a button: it opens the stream
// large in a dialog that stays live. Text types itself (typewriter.ts); everything else re-renders with the snapshot.
import { CircleX } from 'lucide-react';
import type { CSSProperties } from 'react';
import { AnimatedNumber } from '../../../design/components/AnimatedNumber';
import { Dialog } from '../../../design/components/Dialog';
import { Skeleton } from '../../../design/components/Skeleton';
import '../../../design/components/StatusPill.css';
import { formatMs, formatTokS, slotLabel, STATE_LOOK, streamSummary, type CardState, type Density, type SlotText, type Stream } from './model';
import { useCountUp, useTypewriter } from './typewriter';

const rateText = (n: number) => formatTokS(n);
const waitText = (ms: number) => formatMs(ms);

/** State as icon + word in its tone (the accent for decoding, which is activity rather than status). */
export function StatePill({ state, iconOnly }: { state: CardState; iconOnly?: boolean }) {
  const look = STATE_LOOK[state];
  const Icon = look.icon;
  return (
    <span className={`status status--pill status--sm strm-pill ${look.tone === 'accent' ? 'strm-tone-accent' : `tone-${look.tone}`}`}>
      <Icon className="status__icon" aria-hidden="true" strokeWidth={2.25} />
      <span className={iconOnly ? 'visually-hidden' : 'status__label'}>{look.label}</span>
    </span>
  );
}

function Typed({ text, added, id, live, className }: { text: string; added: number; id: string; live: boolean; className?: string }) {
  const ref = useTypewriter(text, added, id, live);
  return <span ref={ref} className={className} />;
}

function WaitCounter({ ms, id }: { ms: number | null; id: string }) {
  const ref = useCountUp(ms, id, waitText);
  return <span ref={ref} className="num" />;
}

interface TextProps {
  stream: Stream;
  text: SlotText | undefined;
  state: CardState;
  live: boolean;
}

/** Reasoning (muted, under a small label) then the answer, with a caret after whichever is being written. */
function StreamText({ stream: s, text, state, live, oneLine }: TextProps & { oneLine?: boolean }) {
  const id = text?.key ?? `${s.slot}:${s.req}`;
  const think = text?.think ?? s.think;
  const answer = text?.answer ?? s.text;
  const thinking = !answer && !!think;
  const caret = state === 'decode' && live ? <span className="strm-caret" aria-hidden="true" /> : null;
  if (oneLine) {
    return (
      <span className="strm-line">
        {thinking ? <span className="strm-line__tag">Thinking</span> : null}
        <span className={`strm-line__text${thinking ? ' is-think' : ''}`}>
          <span className="strm-line__inner">
            <Typed text={thinking ? think : answer} added={(thinking ? text?.thinkAdded : text?.added) ?? 0} id={`${id}:${thinking ? 't' : 'a'}`} live={live} />
            {caret}
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="strm-flow">
      {think ? (
        <span className="strm-think">
          <span className="strm-think__label">Thinking</span>
          <Typed text={think} added={text?.thinkAdded ?? 0} id={id} live={live} />
          {thinking ? caret : null}
        </span>
      ) : null}
      {answer || (caret && !thinking) ? (
        <span className="strm-answer">
          <Typed text={answer} added={text?.added ?? 0} id={id} live={live} />
          {caret}
        </span>
      ) : null}
    </span>
  );
}

interface CardProps extends TextProps {
  density: Density;
  /** Requests in this level, for "request 3 of 8". */
  requests: number;
  onOpen: (slot: number) => void;
}

export function StreamCard({ stream: s, text, state, density, requests, live, onOpen }: CardProps) {
  const rate = s.tok_s;
  const compact = density === 'compact';
  const fill = s.max ? Math.min(1, s.tokens / s.max) : state === 'done' ? 1 : 0;
  const id = text?.key ?? `${s.slot}:${s.req}`;
  const hasText = !!(text?.answer ?? s.text) || !!(text?.think ?? s.think);
  return (
    <div role="listitem" className="strm-grid__item">
      <button
        type="button"
        className={`strm-card strm-card--${density} is-${state}${live ? ' is-live' : ''}${state === 'error' ? ' tone-crit' : ''}`}
        style={{ '--i': s.slot } as CSSProperties}
        aria-label={streamSummary(s, state, requests)}
        onClick={() => { onOpen(s.slot); }}
      >
        <span className="strm-card__head">
          <span className="strm-slot">{slotLabel(s.slot)}</span>
          <StatePill state={state} />
          <span className="strm-card__rate">
            {rate == null || (state !== 'decode' && state !== 'done') ? (
              <span className="strm-card__dash">—</span>
            ) : (
              <>
                <AnimatedNumber value={rate} format={rateText} className="strm-card__num" />
                <span className="strm-card__unit">tok/s</span>
              </>
            )}
          </span>
        </span>

        {state === 'wait' ? (
          <span className="strm-body strm-body--wait">
            {compact ? null : <TextLines count={density === 'large' ? 4 : 2} />}
            <span className="strm-wait">
              {compact ? 'Waiting' : 'Waiting for first token'} · {live ? <WaitCounter ms={s.elapsed_ms} id={id} /> : <span className="num">{formatMs(s.elapsed_ms)}</span>}
            </span>
          </span>
        ) : state === 'idle' ? (
          <span className="strm-body strm-body--empty">No request yet</span>
        ) : state === 'stopped' && !hasText ? (
          <span className="strm-body strm-body--empty">Stopped before the first token</span>
        ) : state === 'error' && !hasText && compact ? (
          <span className="strm-body strm-body--empty strm-error">{s.error ?? 'Failed before the first token'}</span>
        ) : (
          <span className="strm-body" aria-live="off">
            <StreamText stream={s} text={text} state={state} live={live} oneLine={compact} />
            {state === 'error' && s.error && !compact ? (
              <span className="strm-error tone-crit">
                <CircleX aria-hidden="true" />
                {s.error}
              </span>
            ) : null}
          </span>
        )}

        <span className="strm-card__foot">
          <span className="strm-meter" aria-hidden="true">
            <span style={{ transform: `scaleX(${fill})` }} />
          </span>
          {compact ? null : (
            <span className="strm-card__meta">
              <span className="strm-card__facts">
                {s.ttft_ms != null ? <span>TTFT {formatMs(s.ttft_ms)}</span> : null}
                {s.req > 0 ? <span>{requests > 0 ? `Request ${s.req} of ${requests}` : `Request ${s.req}`}</span> : null}
              </span>
              <span className="num strm-card__tokens">
                {s.tokens}
                {s.max ? <span className="strm-card__max"> / {s.max}</span> : null}
              </span>
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

const LINE_WIDTHS = ['94%', '86%', '91%', '72%', '88%', '64%', '83%'];

/** Shimmering lines where text will appear. */
function TextLines({ count }: { count: number }) {
  return (
    <span className="strm-body__sk" aria-hidden="true">
      {LINE_WIDTHS.slice(0, count).map((w, i) => <Skeleton key={i} height={7} width={w} radius={4} />)}
    </span>
  );
}

/** A card-sized placeholder for a slot that has not reported yet. */
export function SkeletonCard({ slot, density }: { slot: number; density: Density }) {
  return (
    <div className="strm-grid__item">
      <span className={`strm-card strm-card--${density} is-skeleton`}>
        <span className="strm-card__head">
          <span className="strm-slot">{slotLabel(slot)}</span>
          <Skeleton width={76} height={18} radius={999} />
          <span className="strm-card__rate"><Skeleton width={58} height={12} /></span>
        </span>
        <span className="strm-body strm-body--wait">
          <TextLines count={density === 'large' ? 6 : density === 'medium' ? 3 : 1} />
        </span>
        <span className="strm-card__foot">
          <span className="strm-meter" />
          {density === 'compact' ? null : (
            <span className="strm-card__meta">
              <Skeleton width={120} height={8} />
              <Skeleton width={40} height={8} />
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

interface DialogProps extends TextProps {
  requests: number;
  /** "Level 4 of 6 · 8 streams", "Final output". */
  context: string;
  onClose: () => void;
}

/** One stream large: its numbers, and everything this page has seen it write (still typing while live). */
export function StreamDialog({ stream: s, text, state, live, requests, context, onClose }: DialogProps) {
  const rate = s.tok_s;
  const facts: [string, string][] = [
    [state === 'done' ? 'Decode speed' : live ? 'Speed now' : 'Last speed', rate == null ? '—' : `${formatTokS(rate)} tok/s`],
    ['Peak', s.peak_tok_s == null ? '—' : `${formatTokS(s.peak_tok_s)} tok/s`],
    ['Tokens', s.max ? `${s.tokens} of ${s.max}` : String(s.tokens)],
    ['Time to first token', formatMs(s.ttft_ms)],
    ['Elapsed', formatMs(s.elapsed_ms)],
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Stream ${slotLabel(s.slot)}`}
      description={[s.req ? (requests ? `Request ${s.req} of ${requests}` : `Request ${s.req}`) : 'No request yet', context].join(' · ')}
      size="lg"
      className="strm-dialog"
    >
      <div className="strm-dialog__top">
        <StatePill state={state} />
        <dl className="strm-dialog__facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {/* Bottom-anchored (column-reverse), so it follows new text unless the reader scrolls up. Focusable to scroll. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="strm-dialog__scroll" tabIndex={0} role="region" aria-label={`Text of stream ${slotLabel(s.slot)}`}>
        <div className="strm-dialog__text" aria-live="off">
          {state === 'wait' ? (
            <p className="strm-wait">Waiting for the first token…</p>
          ) : state === 'idle' ? (
            <p className="strm-wait">No request yet.</p>
          ) : state === 'stopped' && !(text?.answer ?? s.text) && !(text?.think ?? s.think) ? (
            <p className="strm-wait">Stopped before the first token.</p>
          ) : (
            <StreamText stream={s} text={text} state={state} live={live} />
          )}
          {state === 'error' && s.error ? (
            <p className="strm-error tone-crit">
              <CircleX aria-hidden="true" />
              {s.error}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
