import { Dialog } from '../design/components/Dialog';
import { Kbd } from '../design/components/Kbd';
import { isApple } from '../lib/shortcuts';
import { usePrefs } from '../store/prefs';
import { useUi } from '../store/ui';
import './ShortcutsHelp.css';

export const SHORTCUT_GROUPS: { title: string; items: { keys: string[][]; label: string }[] }[] = [
  {
    title: 'Navigation',
    items: [
      { keys: [['G'], ['O']], label: 'Go to Overview' },
      { keys: [['G'], ['A']], label: 'Go to Alerts' },
      { keys: [['G'], ['B']], label: 'Go to Benchmarks' },
      { keys: [['G'], ['S']], label: 'Go to Settings' },
      { keys: [['1'], ['9']], label: 'Jump to node 1–9' },
    ],
  },
  {
    title: 'General',
    items: [
      { keys: [['mod', 'K']], label: 'Command palette' },
      { keys: [['?']], label: 'Show keyboard shortcuts' },
      { keys: [['W']], label: 'Wall mode' },
      { keys: [['T']], label: 'Toggle light / dark' },
      { keys: [['Esc']], label: 'Close dialog, leave wall mode' },
    ],
  },
];

export function ShortcutsHelp() {
  const open = useUi((s) => s.helpOpen);
  const setHelp = useUi((s) => s.setHelp);
  const mod = isApple() ? '⌘' : 'Ctrl';
  const singleKeys = usePrefs((s) => s.singleKeyShortcuts);
  const setPrefs = usePrefs((s) => s.set);
  return (
    <Dialog open={open} onClose={() => { setHelp(false); }} title="Keyboard shortcuts" size="lg" description="Shortcuts are paused while you type in a field.">
      <div className="shortcuts">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} aria-labelledby={`sc-${g.title}`}>
            <h3 id={`sc-${g.title}`} className="shortcuts__title">{g.title}</h3>
            <dl className="shortcuts__list">
              {g.items.map((it) => (
                <div key={it.label} className="shortcuts__row">
                  <dt>{it.label}</dt>
                  <dd>
                    {it.keys.map((combo, i) => (
                      <span key={i} className="shortcuts__combo">
                        {i > 0 ? <span className="shortcuts__then">{it.label.startsWith('Jump') ? '–' : 'then'}</span> : null}
                        {combo.map((k) => <Kbd key={k}>{k === 'mod' ? mod : k}</Kbd>)}
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <label className="shortcuts__toggle">
        <input type="checkbox" checked={singleKeys} onChange={(e) => { setPrefs({ singleKeyShortcuts: e.target.checked }); }} />
        <span>
          Single-key shortcuts
          <span className="shortcuts__hint">Everything except {mod} K. Turn off if keys fire by accident, for example with speech input.</span>
        </span>
      </label>
    </Dialog>
  );
}
