import { Keyboard } from 'lucide-react';
import { Button } from '../design/components/Button';
import { Panel } from '../design/components/Panel';
import { ProblemState } from '../design/components/ProblemState';
import { SegmentedControl, type Segment } from '../design/components/SegmentedControl';
import type { ThemePref } from '../lib/prefs';
import { usePrefs } from '../store/prefs';
import { useUi } from '../store/ui';
import { Switch } from './alerts/parts/Switch';
import { AboutSection } from './settings/AboutSection';
import { DataSection } from './settings/DataSection';
import { SettingRow, SettingRowSkeleton } from './settings/parts';
import { BenchSection, EnergySection, FreshnessSection } from './settings/ServerSections';
import { useServerSettings } from './settings/useServerSettings';
import './settings/settings.css';
import './views.css';

const THEMES: readonly Segment<ThemePref>[] = [
  { value: 'system', label: 'System', ariaLabel: 'Match the system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/** Settings: browser preferences (saved locally) first, then console settings (saved on the server for everyone). */
export default function Settings() {
  const server = useServerSettings();
  return (
    <div className="view view--narrow settings">
      <p className="settings__group t-eyebrow">This browser</p>
      <AppearanceSection />
      <KeyboardSection />
      <p className="settings__group t-eyebrow">Console · shared by everyone who uses this Sparkline</p>
      {server.load.status === 'ready' ? (
        <>
          <EnergySection current={server.load.settings} save={server.save} />
          <FreshnessSection current={server.load.settings} save={server.save} />
          <BenchSection current={server.load.settings} save={server.save} />
        </>
      ) : server.load.status === 'error' ? (
        <Panel title="Console settings">
          <ProblemState compact message={server.load.problem.message} cause={server.load.problem.cause} fix={server.load.problem.fix} onRetry={server.retry} />
        </Panel>
      ) : (
        (['Energy', 'Data freshness', 'Benchmarks'] as const).map((t, i) => (
          <Panel key={t} title={t} busy>
            <div className="set-rows">
              {Array.from({ length: i === 2 ? 1 : 2 }, (_, j) => <SettingRowSkeleton key={j} control={120} />)}
            </div>
          </Panel>
        ))
      )}
      <DataSection />
      <AboutSection />
    </div>
  );
}

function AppearanceSection() {
  const theme = usePrefs((s) => s.theme);
  const reduce = usePrefs((s) => s.reduceTransparency);
  const set = usePrefs((s) => s.set);
  return (
    <Panel title="Appearance">
      <div className="set-rows">
        <SettingRow id="set-theme" title="Theme" description="System follows your operating system's light or dark setting. Press T anywhere to switch.">
          <SegmentedControl label="Theme" options={THEMES} value={theme} onChange={(v) => { set({ theme: v }); }} />
        </SettingRow>
        <SettingRow id="set-transp" title="Reduce transparency" description="Replace translucent, blurred surfaces with solid ones. Also follows the system setting.">
          <Switch checked={reduce} onChange={(v) => { set({ reduceTransparency: v }); }} labelledBy="set-transp-label" describedBy="set-transp-desc" />
        </SettingRow>
      </div>
    </Panel>
  );
}

function KeyboardSection() {
  const single = usePrefs((s) => s.singleKeyShortcuts);
  const set = usePrefs((s) => s.set);
  const setHelp = useUi((s) => s.setHelp);
  return (
    <Panel title="Keyboard">
      <div className="set-rows">
        <SettingRow id="set-keys" title="Single-key shortcuts" description="G then O for Overview, 1–9 for nodes, T, W and ?. Turn off if keys fire by accident, for example with speech input. The command palette shortcut always works.">
          <Switch checked={single} onChange={(v) => { set({ singleKeyShortcuts: v }); }} labelledBy="set-keys-label" describedBy="set-keys-desc" />
        </SettingRow>
        <SettingRow id="set-help" title="All shortcuts" description="See every keyboard shortcut. Press ? anywhere.">
          <Button size="sm" variant="secondary" icon={<Keyboard />} onClick={() => { setHelp(true); }}>
            Show shortcuts
          </Button>
        </SettingRow>
      </div>
    </Panel>
  );
}
