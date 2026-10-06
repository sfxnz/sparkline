// Motion tokens. Springs settle within the brief's 150–400 ms window (snappy ≈ 200 ms, gentle ≈ 350 ms).
export const springs = {
  snappy: { type: 'spring', stiffness: 520, damping: 42, mass: 1 },
  gentle: { type: 'spring', stiffness: 200, damping: 28, mass: 1 },
} as const;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
