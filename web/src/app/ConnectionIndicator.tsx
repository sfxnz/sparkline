import { RotateCw } from 'lucide-react';
import { Button } from '../design/components/Button';
import { useNow } from '../design/useNow';
import type { ConnState } from '../lib/ws';
import { useCluster } from '../store/cluster';
import { useConnection } from '../store/connection';
import { retryConnection } from '../store/session';
import './ConnectionIndicator.css';

export function connectionLabel(s: Pick<ConnState, 'status' | 'retryAt'>, now: number): { text: string; tone: 'ok' | 'warn' | 'stale' } {
  switch (s.status) {
    case 'live':
      return { text: 'Live', tone: 'ok' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'stale' };
    case 'reconnecting': {
      if (s.retryAt === null) return { text: 'Reconnecting…', tone: 'warn' };
      const secs = Math.max(0, Math.ceil((s.retryAt - now) / 1000));
      return { text: secs > 0 ? `Reconnecting in ${secs} s` : 'Reconnecting…', tone: 'warn' };
    }
    case 'offline':
      return { text: 'Offline', tone: 'stale' };
    case 'unauthorized':
      return { text: 'Signed out', tone: 'stale' };
  }
}

/** Dot + label (never colour alone), a Retry action while disconnected, and a Demo badge in demo mode. */
export function ConnectionIndicator({ showRetry = true }: { showRetry?: boolean }) {
  const state = useConnection();
  const demo = useCluster((s) => s.cluster?.demo ?? false);
  const now = useNow(state.status === 'reconnecting' ? 250 : 5000);
  const { text, tone } = connectionLabel(state, now);
  const canRetry = showRetry && (state.status === 'reconnecting' || state.status === 'offline');

  return (
    <div className="conn">
      {demo ? <span className="conn__demo" title="Simulated telemetry (sparkline --demo)">Demo</span> : null}
      <span className={`conn__status tone-${tone}`} role="status" aria-live="off">
        <span className={`conn__dot${state.status === 'live' ? ' conn__dot--live' : ''}`} aria-hidden="true" />
        <span className="conn__label num">{text}</span>
      </span>
      {canRetry ? (
        <Button size="sm" variant="ghost" icon={<RotateCw />} onClick={retryConnection}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
