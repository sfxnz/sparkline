// In a history range (5m/1h/24h/7d) the stat row still shows live values while the charts show the range: say so,
// once, above the row, so "65 %" here and "80%" in a chart legend are not two different "now"s.
import { usePrefs } from '../../../store/prefs';
import { RANGE_PHRASE } from '../../shared/live';

export function NowLabel() {
  const range = usePrefs((s) => s.timeRange);
  if (range === 'live') return null;
  return (
    <p className="nnow">
      <strong>Now</strong> · live values; the charts show the {RANGE_PHRASE[range]}
    </p>
  );
}
