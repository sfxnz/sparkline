import { useCallback, useEffect, useState } from 'react';
import type { ConsoleSettings, Problem } from '../../lib/types';
import { useCluster } from '../../store/cluster';
import { api, problemOf } from '../../lib/api';
import { apply, changed, toDraft, validate, type Draft, type SettingsKey } from './model';

type Load = { status: 'loading' } | { status: 'error'; problem: Problem } | { status: 'ready'; settings: ConsoleSettings };

/** Console settings: fetched fresh (the hello snapshot may be old), mirrored into the cluster store on save. */
export function useServerSettings() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .settings()
      .then((settings) => { if (!cancelled) setLoad({ status: 'ready', settings }); })
      .catch((e: unknown) => { if (!cancelled) setLoad({ status: 'error', problem: problemOf(e, 'load the console settings') }); });
    return () => { cancelled = true; };
  }, [attempt]);

  const save = useCallback(async (next: ConsoleSettings) => {
    const saved = await api.putSettings(next);
    setLoad({ status: 'ready', settings: saved });
    useCluster.setState((s) => (s.cluster ? { cluster: { ...s.cluster, settings: saved } } : {}));
    return saved;
  }, []);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return { load, save, retry };
}

export type SaveStatus = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; problem: Problem };

/** One settings section: its own draft of a few fields, validation, dirty state, Save and Revert. */
export function useSectionForm(current: ConsoleSettings, fields: readonly SettingsKey[], save: (s: ConsoleSettings) => Promise<ConsoleSettings>) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(current));
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [touched, setTouched] = useState(false);

  const errors = validate(draft, fields);
  const dirty = changed(current, draft, fields);
  const invalid = Object.keys(errors).length > 0;

  useEffect(() => {
    if (status.kind !== 'saved') return;
    const t = setTimeout(() => { setStatus({ kind: 'idle' }); }, 4000);
    return () => { clearTimeout(t); };
  }, [status]);

  const set = (k: SettingsKey, v: string) => {
    setTouched(true);
    setStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = async () => {
    if (!dirty || invalid) return;
    setStatus({ kind: 'saving' });
    try {
      const saved = await save(apply(current, draft, fields));
      setDraft((d) => {
        const fresh = toDraft(saved);
        const out = { ...d };
        for (const k of fields) out[k] = fresh[k];
        return out;
      });
      setTouched(false);
      setStatus({ kind: 'saved' });
    } catch (e) {
      setStatus({ kind: 'error', problem: problemOf(e, 'save the settings') });
    }
  };

  const revert = () => {
    const base = toDraft(current);
    setDraft((d) => {
      const out = { ...d };
      for (const k of fields) out[k] = base[k];
      return out;
    });
    setTouched(false);
    setStatus({ kind: 'idle' });
  };

  return { draft, set, errors: touched ? errors : {}, dirty, invalid, status, submit, revert };
}
