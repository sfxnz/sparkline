import type { CSSProperties } from 'react';
import './Skeleton.css';

interface Props {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** Placeholder block with exact dimensions so the loaded layout does not shift. Decorative: hidden from AT
 *  (wrap loading regions with aria-busy instead). Shimmer stops under reduced motion. */
export function Skeleton({ width = '100%', height = 14, radius = 6, className, style }: Props) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton${className ? ` ${className}` : ''}`}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}
