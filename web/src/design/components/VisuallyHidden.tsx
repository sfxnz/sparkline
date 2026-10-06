import type { ComponentPropsWithoutRef } from 'react';

export function VisuallyHidden(props: ComponentPropsWithoutRef<'span'>) {
  return <span {...props} className="visually-hidden" />;
}
