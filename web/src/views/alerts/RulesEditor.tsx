import { CircleCheck, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../design/components/Button';
import { Panel } from '../../design/components/Panel';
import { ProblemState } from '../../design/components/ProblemState';
import { Skeleton } from '../../design/components/Skeleton';
import type { AlertRule, Problem, Severity } from '../../lib/types';
import '../../design/components/Table.css';
import { api, problemOf } from '../../lib/api';
import { ProblemBanner } from './parts/Banner';
import { NumberField } from './parts/NumberField';
import { Select } from './parts/Select';
import { Switch } from './parts/Switch';
import {
  draftChanged,
  fromDraft,
  hasErrors,
  KIND_CONDITION,
  maskReasons,
  metricMeta,
  RULE_METRICS,
  ruleIdInError,
  toDraft,
  toggleBit,
  UNIT_SUFFIX,
  unitFor,
  validateDraft,
  type RuleDraft,
  type RuleErrors,
} from './rules';

type Patch = Partial<Omit<RuleDraft, 'rule'>> & { rule?: Partial<AlertRule> };
type Load = { status: 'loading' } | { status: 'error'; problem: Problem } | { status: 'ready'; saved: AlertRule[] };

export function RulesEditor() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ problem: Problem; ruleId: string | null } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .rules()
      .then((rules) => {
        if (cancelled) return;
        setLoad({ status: 'ready', saved: rules });
        setDrafts(rules.map(toDraft));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ status: 'error', problem: problemOf(e, 'load the alert rules') });
      });
    return () => { cancelled = true; };
  }, [attempt]);

  const saved = useMemo(() => (load.status === 'ready' ? load.saved : []), [load]);
  const savedById = useMemo(() => new Map(saved.map((r) => [r.id, r])), [saved]);
  const errors = useMemo(() => drafts.map(validateDraft), [drafts]);
  const changed = drafts.map((d) => draftChanged(d, savedById.get(d.rule.id)));
  const dirty = changed.some(Boolean) || drafts.length !== saved.length;
  const invalid = errors.some(hasErrors);

  // Leaving the page with unsaved edits asks first (browser close / reload).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); };
  }, [dirty]);

  useEffect(() => {
    if (savedAt === null) return;
    const t = setTimeout(() => { setSavedAt(null); }, 4000);
    return () => { clearTimeout(t); };
  }, [savedAt]);

  const update = useCallback((i: number, patch: Patch) => {
    setSavedAt(null);
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch, rule: { ...d.rule, ...patch.rule } } : d)));
  }, []);

  const revert = () => {
    setDrafts(saved.map(toDraft));
    setSaveError(null);
  };

  const save = async () => {
    if (invalid || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.putRules(drafts.map(fromDraft));
      setLoad({ status: 'ready', saved: result });
      setDrafts(result.map(toDraft));
      setSavedAt(Date.now());
    } catch (e) {
      const problem = problemOf(e, 'save the alert rules');
      setSaveError({ problem, ruleId: ruleIdInError(`${problem.message} ${problem.cause}`) });
    } finally {
      setSaving(false);
    }
  };

  const changedCount = changed.filter(Boolean).length;
  const actions =
    load.status === 'ready' ? (
      <div className="rules-actions">
        <span className="rules-actions__state t-footnote" role="status">
          {savedAt ? (
            <span className="rules-saved">
              <CircleCheck aria-hidden="true" /> Saved
            </span>
          ) : dirty ? (
            invalid ? 'Fix the highlighted fields to save' : `${changedCount} unsaved ${changedCount === 1 ? 'change' : 'changes'}`
          ) : null}
        </span>
        <Button size="sm" variant="ghost" icon={<RotateCcw />} disabled={!dirty || saving} onClick={revert}>
          Revert
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty || invalid || saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    ) : undefined;

  return (
    <Panel title="Rules" subtitle="Thresholds that raise alerts. Changes apply to every node as soon as they are saved." flush={load.status === 'ready'} busy={load.status === 'loading'}>
      {load.status === 'loading' ? (
        <RulesSkeleton />
      ) : load.status === 'error' ? (
        <ProblemState compact message={load.problem.message} cause={load.problem.cause} fix={load.problem.fix} onRetry={() => { setLoad({ status: 'loading' }); setAttempt((n) => n + 1); }} />
      ) : (
        <>
          {saveError ? (
            <div className="rules-error">
              <ProblemBanner problem={saveError.problem} />
            </div>
          ) : null}
          <div className="table-wrap">
            <table className="table rules-table">
              <caption className="visually-hidden">Alert rules. Each row can be edited; save to apply.</caption>
              <thead>
                <tr>
                  <th scope="col" className="rules-col-on">On</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Condition</th>
                  <th scope="col">For</th>
                  <th scope="col">Severity</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d, i) => (
                  <RuleRow
                    key={d.rule.id}
                    d={d}
                    errors={errors[i] ?? {}}
                    changed={changed[i] ?? false}
                    rejected={saveError?.ruleId === d.rule.id}
                    onChange={(patch) => { update(i, patch); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {/* Sticky: Save stays in reach while editing any row of a long table. */}
          <div className={`rules-footer${dirty ? ' is-dirty' : ''}`}>{actions}</div>
        </>
      )}
    </Panel>
  );
}

const SEVERITY_OPTIONS: Severity[] = ['info', 'warning', 'critical'];
const SEVERITY_TEXT: Record<Severity, string> = { info: 'Info', warning: 'Warning', critical: 'Critical' };

interface RowProps {
  d: RuleDraft;
  errors: RuleErrors;
  changed: boolean;
  rejected: boolean;
  onChange: (patch: Patch) => void;
}

function RuleRow({ d, errors, changed, rejected, onChange }: RowProps) {
  const { rule } = d;
  const name = rule.name.trim() || rule.id;
  const showErrors = changed;
  const meta = metricMeta(rule.metric);
  const unit = unitFor(rule.metric);
  const knownMetric = RULE_METRICS.some((m) => m.key === rule.metric);
  const reasonsId = `rule-${rule.id}-reasons`;

  return (
    <tr className={`rules-row${rule.enabled ? '' : ' is-disabled'}${changed ? ' is-changed' : ''}${rejected ? ' is-rejected' : ''}`}>
      <td className="rules-col-on">
        <Switch checked={rule.enabled} onChange={(enabled) => { onChange({ rule: { enabled } }); }} label={`Enable rule: ${name}`} />
      </td>
      <td className="rules-col-name">
        <div className="rules-name">
          <input
            className="rules-name__input"
            value={rule.name}
            aria-label={`Rule name (${rule.id})`}
            aria-invalid={showErrors && errors.name ? true : undefined}
            onChange={(e) => { onChange({ rule: { name: e.target.value } }); }}
          />
          {changed ? <span className="rules-dot" title="Edited, not saved yet"><span className="visually-hidden">Edited, not saved yet</span></span> : null}
        </div>
        {showErrors && errors.name ? <span className="ops-error">{errors.name}</span> : null}
        {rejected ? <span className="ops-error">The console rejected this rule. See the message above.</span> : null}
      </td>
      <td className="rules-col-cond">
        {rule.kind === 'threshold' ? (
          <div className="rules-cond">
            <span className="rules-cond__word">When</span>
            <span className="rules-metric">
              <Select size="sm" aria-label={`${name}: metric`} value={rule.metric ?? ''} onChange={(e) => { onChange({ rule: { metric: e.target.value } }); }}>
                {!knownMetric && rule.metric ? <option value={rule.metric}>{meta.label}</option> : null}
                {RULE_METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </Select>
              <code className="rules-metric__key">{rule.metric}</code>
            </span>
            <span className="rules-cond__word">is</span>
            <Select size="sm" aria-label={`${name}: comparison`} value={rule.op} onChange={(e) => { onChange({ rule: { op: e.target.value === '<' ? '<' : '>' } }); }}>
              <option value=">">above</option>
              <option value="<">below</option>
            </Select>
            <NumberField
              label={`${name}: threshold${UNIT_SUFFIX[unit] ? ` in ${UNIT_SUFFIX[unit]}` : ''}`}
              unit={UNIT_SUFFIX[unit]}
              value={d.thresholdText}
              onChange={(thresholdText) => { onChange({ thresholdText }); }}
              error={showErrors ? errors.threshold : undefined}
              width="6.5rem"
            />
          </div>
        ) : rule.kind === 'throttle' ? (
          <fieldset className="rules-throttle" aria-describedby={showErrors && errors.mask ? `${reasonsId}-err` : undefined}>
            <legend className="rules-cond__word">When the GPU reports any of</legend>
            <div className="rules-throttle__grid">
              {maskReasons(rule.threshold).map((r) => (
                <label key={r.bit} className="rules-check" title={r.explanation}>
                  <input type="checkbox" checked={r.checked} onChange={(e) => { onChange({ rule: { threshold: toggleBit(rule.threshold, r.bit, e.target.checked) } }); }} />
                  <span>{r.title}</span>
                </label>
              ))}
            </div>
            {showErrors && errors.mask ? <span id={`${reasonsId}-err`} className="ops-error">{errors.mask}</span> : null}
          </fieldset>
        ) : (
          <p className="rules-cond__text">{KIND_CONDITION[rule.kind]}</p>
        )}
      </td>
      <td className="rules-col-for">
        <NumberField label={`${name}: for how many seconds`} unit="s" value={d.forText} onChange={(forText) => { onChange({ forText }); }} error={showErrors ? errors.for_s : undefined} width="5.5rem" />
      </td>
      <td className="rules-col-sev">
        <Select size="sm" aria-label={`${name}: severity`} value={rule.severity} onChange={(e) => { onChange({ rule: { severity: e.target.value as Severity } }); }}>
          {SEVERITY_OPTIONS.map((s) => <option key={s} value={s}>{SEVERITY_TEXT[s]}</option>)}
        </Select>
      </td>
    </tr>
  );
}

function RulesSkeleton() {
  return (
    <div className="rules-skeleton">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="rules-skeleton__row">
          <Skeleton width={38} height={22} radius={11} />
          <Skeleton width={150 + ((i * 23) % 40)} height={14} />
          <Skeleton width={320} height={28} radius={8} />
          <Skeleton width={72} height={28} radius={8} />
          <Skeleton width={92} height={28} radius={8} />
        </div>
      ))}
    </div>
  );
}
