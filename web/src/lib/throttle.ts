// NVML clocks-event-reasons decode table. Canonical: must match server/sparkline/common/throttle.py.
import type { Severity } from './types';

export interface ThrottleReason {
  bit: number;
  code: string;
  title: string;
  severity: Severity;
  explanation: string;
}

export const THROTTLE_REASONS: readonly ThrottleReason[] = [
  { bit: 0x1, code: 'gpu_idle', title: 'Idle', severity: 'info', explanation: 'Clocks are lowered because the GPU has nothing to do.' },
  { bit: 0x2, code: 'app_clocks', title: 'Application clock limit', severity: 'info', explanation: 'An application or administrator has set a clock limit.' },
  { bit: 0x4, code: 'sw_power_cap', title: 'Power cap', severity: 'info', explanation: 'Holding clocks down to stay within the power budget. Normal under sustained heavy load.' },
  { bit: 0x8, code: 'hw_slowdown', title: 'Hardware slowdown', severity: 'critical', explanation: 'Hardware forced clocks down to protect the chip (thermal or power-brake protection).' },
  { bit: 0x10, code: 'sync_boost', title: 'Sync boost', severity: 'info', explanation: 'Clocks matched to other GPUs in a sync-boost group.' },
  { bit: 0x20, code: 'sw_thermal', title: 'Thermal limit', severity: 'warning', explanation: 'Clocks reduced in software to keep temperature below the target.' },
  { bit: 0x40, code: 'hw_thermal', title: 'Overheating', severity: 'critical', explanation: 'The GPU is too hot; hardware cut clocks sharply to protect itself.' },
  { bit: 0x80, code: 'hw_power_brake', title: 'Power brake', severity: 'critical', explanation: 'An external power-brake signal forced clocks down (power supply limit).' },
  { bit: 0x100, code: 'display_clocks', title: 'Display clock setting', severity: 'info', explanation: 'Clocks limited by display clock settings.' },
];

const BY_BIT = new Map(THROTTLE_REASONS.map((r) => [r.bit, r]));

/** Decode a clocks-event-reasons bitmask into reasons, lowest bit first. Unknown bits are reported, not dropped. */
export function decodeThrottle(mask: number | null | undefined): ThrottleReason[] {
  if (mask == null || !Number.isFinite(mask) || mask <= 0) return [];
  const out: ThrottleReason[] = [];
  // Masks are up to 64-bit in NVML; JS numbers are exact up to 2^53, which covers every defined bit.
  let rest = Math.trunc(mask);
  for (let bit = 1; rest > 0; bit *= 2) {
    if (rest % (bit * 2) >= bit) {
      const hex = `0x${bit.toString(16)}`;
      out.push(
        BY_BIT.get(bit) ?? {
          bit,
          code: `unknown_${hex}`,
          title: `Unknown reason (bit ${hex})`,
          severity: 'warning',
          explanation: 'The driver reported a clock-event reason this console does not recognise.',
        },
      );
      rest -= bit;
    }
  }
  return out;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** The most severe severity in a list, or null when empty. */
export function worstSeverity(items: readonly { severity: Severity }[]): Severity | null {
  let worst: Severity | null = null;
  for (const it of items) if (worst === null || RANK[it.severity] > RANK[worst]) worst = it.severity;
  return worst;
}
