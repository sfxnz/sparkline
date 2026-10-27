// A finished llm-showcase run's outputs: every stream's prompt and whole text (detail.showcase, not the live tails),
// open from the start, each card scrolling on its own, with Copy per stream and Copy all as Markdown.
import { Check, CircleX, Copy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../design/components/Button';
import { Panel } from '../../../design/components/Panel';
import type { RunStatus } from '../../../lib/types';
import { Grid } from './LivePanel';
import { densityFor, formatMs, formatTokS, showcaseMarkdown, slotLabel, STATE_LOOK, streamMarkdown, type ShowcaseDetail, type ShowcaseStream } from './model';
import { StatePill } from './StreamCard';

/** Write `text` to the clipboard; the console is often served over plain http on the LAN, where the async clipboard
 * API is missing, so fall back to a hidden textarea and execCommand. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && 'clipboard' in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way to copy outside a secure context
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

type Copied = { key: string; ok: boolean } | null;

/** Which copy just happened (for its button's "Copied" and the status line), cleared after a moment. */
function useCopy() {
  const [copied, setCopied] = useState<Copied>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const copy = (key: string, text: string) => {
    void copyText(text).then((ok) => {
      setCopied({ key, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setCopied(null); }, 2000);
    });
  };
  return { copied, copy };
}

const ENDED: Partial<Record<RunStatus, string>> = { cancelled: ' · stopped when the run was cancelled', failed: ' · cut off when the run failed' };

export function ShowcaseOutputs({ outputs, status, actions }: { outputs: ShowcaseDetail; status: RunStatus; actions: ReactNode }) {
  const { copied, copy } = useCopy();
  const streams = outputs.streams;
  const n = streams.length;
  const density = densityFor(n, 'text');
  const notes = [
    outputs.fill_to_max?.requested && !outputs.fill_to_max.applied ? 'The server rejected the fill-to-length options, so each stream ended when the model did.' : null,
    outputs.truncated ? 'The longest outputs were shortened to keep the run record small.' : null,
  ].filter(Boolean);
  const said = copied ? (copied.ok ? (copied.key === 'all' ? `Copied ${n === 1 ? 'the stream' : `all ${n} streams`} as Markdown` : `Copied stream ${copied.key}`) : 'The browser blocked the clipboard') : '';
  return (
    <Panel
      title="Final outputs"
      subtitle={`${n} ${n === 1 ? 'stream' : 'streams'} · the whole text each wrote${ENDED[status] ?? ''}`}
      actions={
        <div className="strm-actions">
          {actions}
          <Button size="sm" icon={copied?.key === 'all' && copied.ok ? <Check /> : <Copy />} onClick={() => { copy('all', showcaseMarkdown(streams)); }}>
            {copied?.key === 'all' && copied.ok ? 'Copied' : 'Copy all'}
          </Button>
        </div>
      }
      className="strm-outputs"
    >
      <span className="visually-hidden" role="status">{said}</span>
      {notes.length ? <p className="strm-note strm-out__note">{notes.join(' ')}</p> : null}
      <Grid density={density} count={n} label="Final outputs">
        {streams.map((s) => (
          <OutputCard key={s.slot} stream={s} density={density === 'large' ? 'large' : 'medium'} copied={copied?.key === slotLabel(s.slot) && copied.ok} onCopy={() => { copy(slotLabel(s.slot), streamMarkdown(s)); }} />
        ))}
      </Grid>
    </Panel>
  );
}

/** The live card's head and foot around a scrolling body: the prompt, then reasoning (muted) and the answer. */
function OutputCard({ stream: s, density, copied, onCopy }: { stream: ShowcaseStream; density: 'large' | 'medium'; copied: boolean; onCopy: () => void }) {
  const slot = slotLabel(s.slot);
  const name = [`Stream ${slot}: ${STATE_LOOK[s.state].label.toLowerCase()}`, s.error].filter(Boolean).join(', ');
  const empty = !s.text && !s.think;
  return (
    <div role="listitem" className="strm-grid__item">
      <article className={`strm-card strm-card--${density} strm-out is-${s.state}${s.state === 'error' ? ' tone-crit' : ''}`} aria-label={name}>
        <span className="strm-card__head">
          <span className="strm-slot">{slot}</span>
          <StatePill state={s.state} />
          <span className="strm-card__rate">
            {s.decode_tok_s == null ? (
              <span className="strm-card__dash">—</span>
            ) : (
              <>
                <span className="num strm-card__num">{formatTokS(s.decode_tok_s)}</span>
                <span className="strm-card__unit">tok/s</span>
              </>
            )}
          </span>
        </span>
        {s.prompt ? <p className="strm-out__prompt">{s.prompt}</p> : null}

        {/* Focusable to scroll with the keyboard. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="strm-out__scroll" tabIndex={0} role="region" aria-label={`Text of stream ${slot}`}>
          {empty ? (
            <p className="strm-out__empty">{s.state === 'error' ? 'Failed before the first token.' : s.state === 'stopped' ? 'Stopped before the first token.' : 'No text.'}</p>
          ) : (
            <div className="strm-out__text">
              {s.think ? (
                <span className="strm-think">
                  <span className="strm-think__label">Thinking</span>
                  {s.think}
                </span>
              ) : null}
              {s.text ? <span className="strm-answer">{s.text}</span> : null}
            </div>
          )}
          {s.error ? (
            <p className="strm-error tone-crit">
              <CircleX aria-hidden="true" />
              {s.error}
            </p>
          ) : null}
        </div>

        <span className="strm-card__foot">
          <span className="strm-card__meta strm-out__meta">
            <span className="strm-card__facts">
              {s.ttft_ms != null ? <span>TTFT {formatMs(s.ttft_ms)}</span> : null}
              <span>{s.tokens} {s.tokens === 1 ? 'token' : 'tokens'}</span>
            </span>
            <Button variant="ghost" size="sm" icon={copied ? <Check /> : <Copy />} aria-label={copied ? `Copied stream ${slot}` : `Copy stream ${slot}`} onClick={onCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </span>
        </span>
      </article>
    </div>
  );
}
