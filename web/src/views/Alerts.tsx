import { OpenAlerts } from './alerts/OpenAlerts';
import { RulesEditor } from './alerts/RulesEditor';
import { Timeline } from './alerts/Timeline';
import { useAck } from './alerts/useAck';
import { useEventHistory } from './alerts/useEventHistory';
import './alerts/alerts.css';
import './views.css';

/** Alerts: what is firing now (and acknowledge it), what happened (timeline), and the rules that decide. */
export default function Alerts() {
  const { state, retry } = useEventHistory();
  const acker = useAck();
  return (
    <div className="view alerts-view">
      <OpenAlerts loading={state.status === 'loading'} acker={acker} />
      <Timeline load={state} onRetry={retry} />
      <RulesEditor />
    </div>
  );
}
