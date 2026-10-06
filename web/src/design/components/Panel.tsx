import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import './Panel.css';

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  material?: 'thin' | 'regular' | 'thick';
  /** Remove inner padding (e.g. edge-to-edge tables). */
  flush?: boolean;
  className?: string;
  /** Accessible name when there is no visible title. */
  label?: string;
  /** Mark the region busy while its content loads. */
  busy?: boolean;
}

/** A material surface with header and its own error boundary. */
export function Panel({ title, subtitle, actions, children, material = 'regular', flush, className, label, busy }: Props) {
  const name = typeof title === 'string' ? title : label;
  return (
    <section
      className={`panel material-${material}${flush ? ' panel--flush' : ''}${className ? ` ${className}` : ''}`}
      aria-label={name}
      aria-busy={busy || undefined}
    >
      {title || actions ? (
        <header className="panel__header">
          <div className="panel__titles">
            {title ? <h2 className="panel__title">{title}</h2> : null}
            {subtitle ? <p className="panel__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="panel__body">
        <ErrorBoundary what={typeof title === 'string' ? `The ${title} panel` : 'This panel'} compact>
          {children}
        </ErrorBoundary>
      </div>
    </section>
  );
}
