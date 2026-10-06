import { RotateCw, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { InlineCode } from './InlineCode';
import './States.css';

interface Props {
  message: string;
  cause?: string;
  /** Concrete fix; `backticks` render as inline code. */
  fix?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra line under the actions, e.g. an automatic retry countdown. */
  footnote?: ReactNode;
  icon?: LucideIcon;
  compact?: boolean;
  /** Heading level for the message (page-level problems use h1/h2). */
  as?: 'h1' | 'h2' | 'h3' | 'p';
  /** Announce assertively when it appears (role="alert"); off by default to avoid noisy panels. */
  announce?: boolean;
}

export function ProblemState({ message, cause, fix, onRetry, retryLabel = 'Retry', footnote, icon: Icon = TriangleAlert, compact, as: Heading = 'p', announce }: Props) {
  return (
    <div className={`state state--problem${compact ? ' state--compact' : ''}`} role={announce ? 'alert' : undefined}>
      <span className="state__glyph state__glyph--problem" aria-hidden="true">
        <Icon strokeWidth={1.75} />
      </span>
      <Heading className="state__title">{message}</Heading>
      {cause || fix ? (
        <dl className="state__details">
          {cause ? (
            <div>
              <dt>Likely cause</dt>
              <dd><InlineCode text={cause} /></dd>
            </div>
          ) : null}
          {fix ? (
            <div>
              <dt>How to fix</dt>
              <dd><InlineCode text={fix} /></dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {onRetry ? (
        <div className="state__actions">
          <Button variant="secondary" icon={<RotateCw />} onClick={onRetry} size={compact ? 'sm' : 'md'}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
      {footnote ? <p className="state__footnote">{footnote}</p> : null}
    </div>
  );
}
