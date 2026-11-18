import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { InlineCode } from '../../../design/components/InlineCode';
import type { Problem } from '../../../lib/types';
import './parts.css';

interface Props {
  tone: 'ok' | 'warn' | 'crit' | 'stale';
  title: string;
  text?: string;
  action?: ReactNode;
  /** role="alert" for failures the user just caused (save/ack errors). */
  assertive?: boolean;
}

/** Inline message with icon + text (status never by colour alone). `backticks` in text render as code. */
export function Banner({ tone, title, text, action, assertive }: Props) {
  const Icon = tone === 'ok' ? CircleCheck : tone === 'stale' ? Info : TriangleAlert;
  return (
    <div className={`ops-banner tone-${tone}`} role={assertive ? 'alert' : undefined}>
      <Icon aria-hidden="true" />
      <div>
        <p className="ops-banner__title">{title}</p>
        {text ? <p className="ops-banner__text"><InlineCode text={text} /></p> : null}
      </div>
      {action ? <div className="ops-banner__action">{action}</div> : <span />}
    </div>
  );
}

/** The cause and the fix are separate sentences, so they are shown as sentences and not run into one. */
export function ProblemBanner({ problem, action }: { problem: Problem; action?: ReactNode }) {
  const text = [problem.cause, problem.fix]
    .filter(Boolean)
    .map((s) => (/[.!?]$/.test(s) ? s : `${s}.`))
    .join(' ');
  return <Banner tone="crit" title={problem.message} text={text} action={action} assertive />;
}
