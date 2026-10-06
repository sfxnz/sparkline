// Live GPU condition: what the latest sample already shows, before any alert rule has waited out its duration.
// The UI flags these values the moment they appear (red "At slowdown", a critical clock-limit banner), so the node's
// status pill and the cluster sentence must reflect them too; alert durations only gate notifications.
import { decodeThrottle, worstSeverity } from './throttle';

export interface LiveCondition {
  level: 'warning' | 'critical';
  /** Clause after the node name: "spark1 is at its GPU slowdown temperature". */
  text: string;
}

/** Degrees below the slowdown point at which the temperature is flagged as close (matches the node GPU tab). */
export const HEADROOM_WARN_C = 6;

export interface ConditionInput {
  temp_c: number | null | undefined;
  throttle_mask: number | null | undefined;
}

/** The worst live condition of a node's GPU, or null when nothing on screen would be flagged. */
export function liveCondition(gpu: ConditionInput | null | undefined, slowdownC: number | null | undefined): LiveCondition | null {
  if (!gpu) return null;
  const temp = gpu.temp_c;
  if (temp != null && slowdownC != null && temp >= slowdownC) return { level: 'critical', text: 'is at its GPU slowdown temperature' };
  // Info-level reasons (idle, power cap, application clocks) are normal operation and never raise a node.
  const limiting = decodeThrottle(gpu.throttle_mask).filter((r) => r.severity !== 'info');
  const worst = worstSeverity(limiting);
  if (worst === 'critical' || worst === 'warning') {
    const names = limiting.filter((r) => r.severity === worst).map((r) => r.title.toLowerCase());
    return { level: worst, text: `has GPU clocks limited by ${names.join(' and ')}` };
  }
  if (temp != null && slowdownC != null && slowdownC - temp <= HEADROOM_WARN_C) return { level: 'warning', text: 'is heating up' };
  return null;
}

/** Stable identity for equality checks (useLatest re-renders only when this changes). */
export const sameCondition = (a: LiveCondition | null, b: LiveCondition | null) => a === b || (!!a && !!b && a.level === b.level && a.text === b.text);
