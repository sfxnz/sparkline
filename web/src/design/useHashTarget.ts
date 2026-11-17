import { useEffect } from 'react';
import { prefersReducedMotion } from './motion';

/** Arriving with `#<id>` in the address (a link from the getting-started guide): bring that section into view and
 *  move focus to its title, once. The section is a Panel with the same `id`. */
export function useHashTarget(id: string): void {
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    const section = document.getElementById(id);
    section?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    section?.querySelector<HTMLElement>('.panel__title')?.focus({ preventScroll: true });
  }, [id]);
}
