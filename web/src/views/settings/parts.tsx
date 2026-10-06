import { CircleCheck, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../design/components/Button';
import { Skeleton } from '../../design/components/Skeleton';
import type { SaveStatus } from './useServerSettings';

interface RowProps {
  id: string;
  title: string;
  description?: ReactNode;
  /** Point the visible title at a form control with this id (otherwise use `${id}-label` with aria-labelledby). */
  htmlFor?: string;
  children: ReactNode;
}

/** One setting: title + explanation on the left, its control on the right (stacks on narrow screens). */
export function SettingRow({ id, title, description, htmlFor, children }: RowProps) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        {htmlFor ? (
          <label id={`${id}-label`} htmlFor={htmlFor} className="set-row__title">{title}</label>
        ) : (
          <span id={`${id}-label`} className="set-row__title">{title}</span>
        )}
        {description ? <div id={`${id}-desc`} className="set-row__desc">{description}</div> : null}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

export function SettingRowSkeleton({ control = 160 }: { control?: number }) {
  return (
    <div className="set-row" aria-hidden="true">
      <div className="set-row__text">
        <Skeleton width={150} height={14} />
        <Skeleton width={280} height={12} />
      </div>
      <Skeleton width={control} height={32} radius={10} />
    </div>
  );
}

interface ActionsProps {
  dirty: boolean;
  invalid: boolean;
  status: SaveStatus;
  onSave: () => void;
  onRevert: () => void;
}

/** Save / Revert for a settings section, with a polite status line (no announcements per keystroke). */
export function SectionActions({ dirty, invalid, status, onSave, onRevert }: ActionsProps) {
  const saving = status.kind === 'saving';
  return (
    <div className="set-actions">
      <span className="set-actions__state t-footnote" role="status">
        {status.kind === 'saved' ? (
          <span className="set-saved">
            <CircleCheck aria-hidden="true" /> Saved
          </span>
        ) : dirty ? (invalid ? 'Fix the highlighted field to save' : 'Unsaved changes') : null}
      </span>
      <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={!dirty || saving} onClick={onRevert}>
        Revert
      </Button>
      <Button size="sm" variant="primary" disabled={!dirty || invalid || saving} onClick={onSave}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}
