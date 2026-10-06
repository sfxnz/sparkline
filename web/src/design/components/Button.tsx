import type { ComponentPropsWithRef, ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} className={`btn btn--${variant} btn--${size}${className ? ` ${className}` : ''}`}>
      {icon ? <span className="btn__icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Required: icon-only buttons need an accessible name. */
  'aria-label': string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, 'primary'>;
  size?: ButtonSize;
}

export function IconButton({ icon, variant = 'ghost', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button {...rest} type={type} className={`btn btn--icon btn--${variant} btn--${size}${className ? ` ${className}` : ''}`}>
      <span className="btn__icon" aria-hidden="true">{icon}</span>
    </button>
  );
}
