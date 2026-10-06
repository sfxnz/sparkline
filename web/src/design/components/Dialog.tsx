import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, IconButton } from './Button';
import './Dialog.css';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Element to focus when opened (defaults to the first focusable element). */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  /** Hide the visible title (still the accessible name). */
  hideTitle?: boolean;
}

/** Modal built on native <dialog>: inert background, Escape closes, focus returns to the opener. */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md', initialFocus, className, hideTitle }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
      initialFocus?.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, initialFocus]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault(); // keep React in control of `open`
      onClose();
    };
    const onClosed = () => {
      const el = opener.current;
      opener.current = null;
      if (el?.isConnected) el.focus();
    };
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onClosed);
    return () => {
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onClosed);
    };
  }, [onClose]);

  // Unmounted while open (a parent that renders `{open ? <Dialog open /> : null}`): no 'close' event fires, so
  // return focus to the opener here too.
  useEffect(
    () => () => {
      const el = opener.current;
      opener.current = null;
      if (el?.isConnected) el.focus();
    },
    [],
  );

  return (
    // Clicking the backdrop (the <dialog> element itself, outside the sheet) closes; keyboard users have Escape.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      className={`dialog dialog--${size}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {open ? (
        <div className="dialog__sheet material-thick">
          <header className={`dialog__header${hideTitle ? ' dialog__header--hidden' : ''}`}>
            <h2 id={titleId} className="dialog__title">{title}</h2>
            <IconButton aria-label="Close" icon={<X />} size="sm" onClick={onClose} className="dialog__close" />
          </header>
          {description ? <div id={descId} className="dialog__description">{description}</div> : null}
          {children ? <div className="dialog__body">{children}</div> : null}
          {footer ? <footer className="dialog__footer">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  /** What will happen, stated plainly, one item per line. */
  consequences: string[];
  confirmLabel: string;
  destructive?: boolean;
  /** When set, the user must type this phrase before the confirm button enables. */
  confirmPhrase?: string;
  busy?: boolean;
}

/** Confirmation for heavy or destructive actions. Focus starts on Cancel so Enter never confirms by accident. */
export function ConfirmDialog({ open, onCancel, onConfirm, title, consequences, confirmLabel, destructive, confirmPhrase, busy }: ConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState('');
  const phraseId = useId();
  const ready = !confirmPhrase || typed.trim() === confirmPhrase;

  const cancel = () => {
    setTyped('');
    onCancel();
  };
  const confirm = () => {
    setTyped('');
    onConfirm();
  };

  return (
    <Dialog
      open={open}
      onClose={cancel}
      title={title}
      size="sm"
      initialFocus={cancelRef}
      description={
        <>
          <p>This will:</p>
          <ul className="dialog__consequences">
            {consequences.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </>
      }
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={cancel}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'primary'} disabled={!ready || busy} onClick={confirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmPhrase ? (
        <div className="dialog__phrase">
          <label htmlFor={phraseId}>
            Type <code>{confirmPhrase}</code> to confirm
          </label>
          <input id={phraseId} className="input" value={typed} onChange={(e) => { setTyped(e.target.value); }} autoComplete="off" spellCheck={false} />
        </div>
      ) : null}
    </Dialog>
  );
}
