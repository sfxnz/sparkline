import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import './States.css';

interface Props {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon: Icon, title, children, action, compact }: Props) {
  return (
    <div className={`state${compact ? ' state--compact' : ''}`}>
      <span className="state__glyph" aria-hidden="true">
        <Icon strokeWidth={1.75} />
      </span>
      <p className="state__title">{title}</p>
      {children ? <div className="state__copy">{children}</div> : null}
      {action ? <div className="state__actions">{action}</div> : null}
    </div>
  );
}
