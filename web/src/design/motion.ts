// Motion tokens. Springs settle within the brief's 150–400 ms window (snappy ≈ 200 ms, gentle ≈ 350 ms).
export const springs = {
  snappy: { type: 'spring', stiffness: 520, damping: 42, mass: 1 },
  gentle: { type: 'spring', stiffness: 200, damping: 28, mass: 1 },
  /** Shared-element morphs (overview card -> node header): critically damped, visually settled in ~300 ms. */
  layout: { type: 'spring', stiffness: 520, damping: 46, mass: 1, restDelta: 0.5, restSpeed: 10 },
} as const;

/** A node's first reading lands on its card: the values rise into place, once. Skipped entirely under reduced
 *  motion (the caller checks prefersReducedMotion: a fade is still motion here). */
export const arrival: { waiting: { opacity: number; y: number }; landed: { opacity: number[]; y: number[] }; transition: typeof springs.gentle } = {
  waiting: { opacity: 1, y: 0 },
  landed: { opacity: [0, 1], y: [10, 0] },
  transition: springs.gentle,
};

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
