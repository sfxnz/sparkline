import { RotateCw, Unplug, WifiOff } from 'lucide-react';
import { Button } from '../design/components/Button';
import { InlineCode } from '../design/components/InlineCode';
import { useNow } from '../design/useNow';
import type { ConnState } from '../lib/ws';
import { retryConnection } from '../store/session';
import './ConnectionProblem.css';

interface Copy {
  title: string;
  cause: string;
  fix: string;
}

export function problemCopy(s: Pick<ConnState, 'status' | 'lastError'>): Copy {
  if (s.status === 'offline') {
    return {
      title: 'This browser is offline',
      cause: 'There is no network connection, so the console cannot be reached.',
      fix: 'Reconnect to the network. Sparkline resumes automatically.',
    };
  }
  if (s.lastError === 'server') {
    return {
      title: 'Sparkline is having trouble',
      cause: 'The console answered, but with a server error.',
      fix: 'Check its log with `journalctl -u sparkline -n 50`, then retry.',
    };
  }
  if (s.lastError === 'socket') {
    return {
      title: 'Live stream unavailable',
      cause: 'The console is up, but the live stream at `/api/v1/stream` closed before it started.',
      fix: 'Check that a proxy in front of the console forwards WebSocket upgrades, then retry.',
    };
  }
  return {
    title: 'Can’t reach Sparkline',
    cause: 'Nothing is answering for this address. The console service is not running, or is listening elsewhere.',
    fix: 'Start it with `sparkline --demo` for simulated data, or check `systemctl status sparkline` on the cluster.',
  };
}

/** Full-page state while the console has never been reached in this session. The shell chrome stays usable. */
export function ConnectionProblem({ state }: { state: ConnState }) {
  const now = useNow(250);
  const copy = problemCopy(state);
  const secs = state.retryAt === null ? null : Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const Icon = state.status === 'offline' ? WifiOff : Unplug;

  return (
    <div className="conn-problem">
      <section className="conn-problem__card material-regular" aria-labelledby="conn-problem-title">
        <div className="conn-problem__glyph" aria-hidden="true">
          <Icon strokeWidth={1.75} />
        </div>
        <h2 id="conn-problem-title" className="conn-problem__title">{copy.title}</h2>
        <dl className="conn-problem__details">
          <div>
            <dt>Likely cause</dt>
            <dd><InlineCode text={copy.cause} /></dd>
          </div>
          <div>
            <dt>How to fix</dt>
            <dd><InlineCode text={copy.fix} /></dd>
          </div>
        </dl>
        <div className="conn-problem__actions">
          <Button variant="primary" icon={<RotateCw />} onClick={retryConnection}>
            Retry now
          </Button>
          <p className="conn-problem__countdown num" aria-live="off">
            {state.status === 'offline'
              ? 'Waiting for the network…'
              : secs === null
                ? 'Connecting…'
                : secs > 0
                  ? `Retrying automatically in ${secs} s`
                  : 'Retrying…'}
            {state.attempts > 1 ? <span className="conn-problem__attempts"> · attempt {state.attempts}</span> : null}
          </p>
        </div>
      </section>
    </div>
  );
}
