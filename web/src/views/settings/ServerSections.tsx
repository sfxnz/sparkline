import { Panel } from '../../design/components/Panel';
import type { ConsoleSettings } from '../../lib/types';
import { ProblemBanner } from '../alerts/parts/Banner';
import { NumberField } from '../alerts/parts/NumberField';
import { costExample } from './model';
import { SectionActions, SettingRow } from './parts';
import { useSectionForm } from './useServerSettings';

interface Props {
  current: ConsoleSettings;
  save: (s: ConsoleSettings) => Promise<ConsoleSettings>;
}

export function EnergySection({ current, save }: Props) {
  const f = useSectionForm(current, ['energy_rate_per_kwh', 'currency'], save);
  const example = costExample(f.draft.energy_rate_per_kwh, f.draft.currency);
  return (
    <Panel
      title="Energy"
      subtitle="Used for the kWh cost shown next to GPU power. Only the GPU rail is metered; whole-system power is not reported."
      actions={<SectionActions dirty={f.dirty} invalid={f.invalid} status={f.status} onSave={() => { void f.submit(); }} onRevert={f.revert} />}
    >
      <div className="set-rows">
        {f.status.kind === 'error' ? <ProblemBanner problem={f.status.problem} /> : null}
        <SettingRow id="set-rate" htmlFor="set-rate-input" title="Electricity price" description={example ?? 'Price you pay per kilowatt-hour.'}>
          <NumberField id="set-rate-input" describedBy="set-rate-desc" value={f.draft.energy_rate_per_kwh} onChange={(v) => { f.set('energy_rate_per_kwh', v); }} unit={`${f.draft.currency.trim() || '£'}/kWh`} error={f.errors.energy_rate_per_kwh} width="10rem" />
        </SettingRow>
        <SettingRow id="set-cur" htmlFor="set-cur-input" title="Currency" description="Symbol or code shown before costs, for example £, $, € or CHF.">
          <span className="ops-numfield">
            <input
              id="set-cur-input"
              className="input set-text"
              value={f.draft.currency}
              maxLength={12}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`set-cur-desc${f.errors.currency ? ' set-cur-err' : ''}`}
              aria-invalid={f.errors.currency ? true : undefined}
              onChange={(e) => { f.set('currency', e.target.value); }}
            />
            {f.errors.currency ? <span id="set-cur-err" className="ops-error">{f.errors.currency}</span> : null}
          </span>
        </SettingRow>
      </div>
    </Panel>
  );
}

export function FreshnessSection({ current, save }: Props) {
  const f = useSectionForm(current, ['stale_after_s', 'offline_after_s'], save);
  return (
    <Panel
      title="Data freshness"
      subtitle="When a node stops sending samples, its values dim and say how old they are, then it is marked offline."
      actions={<SectionActions dirty={f.dirty} invalid={f.invalid} status={f.status} onSave={() => { void f.submit(); }} onRevert={f.revert} />}
    >
      <div className="set-rows">
        {f.status.kind === 'error' ? <ProblemBanner problem={f.status.problem} /> : null}
        <SettingRow id="set-stale" htmlFor="set-stale-input" title="Mark “Not reporting” after" description="No sample for this long: the node shows Not reporting and its values dim with “updated N s ago”.">
          <NumberField id="set-stale-input" describedBy="set-stale-desc" value={f.draft.stale_after_s} onChange={(v) => { f.set('stale_after_s', v); }} unit="s" error={f.errors.stale_after_s} />
        </SettingRow>
        <SettingRow id="set-offline" htmlFor="set-offline-input" title="Mark “Offline” after" description="No sample for this long: the node shows Offline and the Node offline alert can fire.">
          <NumberField id="set-offline-input" describedBy="set-offline-desc" value={f.draft.offline_after_s} onChange={(v) => { f.set('offline_after_s', v); }} unit="s" error={f.errors.offline_after_s} />
        </SettingRow>
      </div>
    </Panel>
  );
}

export function BenchSection({ current, save }: Props) {
  const f = useSectionForm(current, ['regression_pct'], save);
  return (
    <Panel
      title="Benchmarks"
      subtitle="How results are compared with the baseline you set for each benchmark."
      actions={<SectionActions dirty={f.dirty} invalid={f.invalid} status={f.status} onSave={() => { void f.submit(); }} onRevert={f.revert} />}
    >
      <div className="set-rows">
        {f.status.kind === 'error' ? <ProblemBanner problem={f.status.problem} /> : null}
        <SettingRow id="set-reg" htmlFor="set-reg-input" title="Regression threshold" description="Flag a result as a regression when it is worse than its baseline by more than this.">
          <NumberField id="set-reg-input" describedBy="set-reg-desc" value={f.draft.regression_pct} onChange={(v) => { f.set('regression_pct', v); }} unit="%" error={f.errors.regression_pct} />
        </SettingRow>
      </div>
    </Panel>
  );
}
