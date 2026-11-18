import { useEffect } from 'react';
import { prefersReducedMotion } from './motion';

/** What a person does to move the page themselves. */
const MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
const HOLD_MS = 2000;

/**
 * Scroll `el` into view and keep it there while the page settles: what is above it may still be loading, and the
 * toolbar it sits under changes height between pages. The hold ends when the person moves or after two seconds.
 * 'nearest' moves the page only as far as needed, and becomes 'start' for an element taller than the room under the
 * toolbar, so its title is never the part left out. Returns the function that ends the hold early.
 */
export function bringIntoView(el: HTMLElement, block: 'start' | 'nearest'): () => void {
  let smooth = !prefersReducedMotion();
  const go = () => {
    const toolbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-offset')) || 0;
    const fits = el.offsetHeight <= window.innerHeight - toolbar - 32;
    el.scrollIntoView({ block: fits ? block : 'start', behavior: smooth ? 'smooth' : 'auto' });
    smooth = false; // the first move may glide; a correction after it does not
  };
  if (typeof ResizeObserver === 'undefined') {
    go();
    return () => undefined;
  }
  // An observer reports once when it starts, after this frame's layout: that report is the first move, so it sees
  // the page as the renders of this frame left it.
  const hold = new ResizeObserver(go);
  hold.observe(document.body);
  const release = () => {
    hold.disconnect();
    clearTimeout(timer);
    for (const move of MOVES) window.removeEventListener(move, release);
  };
  const timer = setTimeout(release, HOLD_MS);
  for (const move of MOVES) window.addEventListener(move, release, { passive: true });
  return release;
}

/** Arriving with `#<id>` in the address (a link from the getting-started guide): bring that section into view and
 *  move focus to its title, once. The section is a Panel with the same `id`. */
export function useHashTarget(id: string): void {
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    const section = document.getElementById(id);
    if (!section) return;
    const release = bringIntoView(section, 'start');
    section.querySelector<HTMLElement>('.panel__title')?.focus({ preventScroll: true });
    return release;
  }, [id]);
}
