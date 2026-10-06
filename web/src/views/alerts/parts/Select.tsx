import { ChevronsUpDown } from 'lucide-react';
import type { ComponentPropsWithoutRef } from 'react';
import './parts.css';

/** Native <select> (best keyboard + screen-reader support) dressed to match the design system. */
export function Select({ className, size = 'md', ...rest }: Omit<ComponentPropsWithoutRef<'select'>, 'size'> & { size?: 'sm' | 'md' }) {
  return (
    <span className={`ops-select ops-select--${size}${className ? ` ${className}` : ''}`}>
      <select {...rest} />
      <ChevronsUpDown className="ops-select__icon" aria-hidden="true" />
    </span>
  );
}
