import { Bell, Blend, CornerDownLeft, Gauge, Keyboard, LayoutGrid, Monitor, PanelLeft, Search, Server, Settings, SunMoon, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useLocation } from 'wouter';
import { Dialog } from '../design/components/Dialog';
import { Kbd } from '../design/components/Kbd';
import { fuzzyFilter } from '../lib/fuzzy';
import { nextTheme, resolveTheme } from '../lib/prefs';
import { useCluster } from '../store/cluster';
import { usePrefs } from '../store/prefs';
import { useUi } from '../store/ui';
import { NODE_TABS, paths } from './routes';
import './CommandPalette.css';

export interface Command {
  id: string;
  group: 'Go to' | 'Nodes' | 'Actions';
  label: string;
  /** Extra words that should match ("dark light appearance"). */
  keywords?: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}


function useCommands(close: () => void): Command[] {
  const [, navigate] = useLocation();
  const order = useCluster((s) => s.order);
  const theme = usePrefs((s) => s.theme);
  const reduceTransparency = usePrefs((s) => s.reduceTransparency);
  const collapsed = usePrefs((s) => s.sidebarCollapsed);
  const singleKeys = usePrefs((s) => s.singleKeyShortcuts);
  const setPrefs = usePrefs((s) => s.set);
  const cycleTheme = usePrefs((s) => s.cycleTheme);
  const setHelp = useUi((s) => s.setHelp);

  return useMemo(() => {
    const go = (to: string) => () => { close(); navigate(to); };
    const cmds: Command[] = [
      { id: 'go-overview', group: 'Go to', label: 'Overview', icon: LayoutGrid, hint: 'G O', run: go(paths.overview) },
      { id: 'go-alerts', group: 'Go to', label: 'Alerts', keywords: 'events timeline rules', icon: Bell, hint: 'G A', run: go(paths.alerts) },
      { id: 'go-benchmarks', group: 'Go to', label: 'Benchmarks', keywords: 'bench runs results', icon: Gauge, hint: 'G B', run: go(paths.benchmarks) },
      { id: 'go-settings', group: 'Go to', label: 'Settings', keywords: 'preferences energy rate', icon: Settings, hint: 'G S', run: go(paths.settings) },
    ];
    order.forEach((id, i) => {
      cmds.push({ id: `node-${id}`, group: 'Nodes', label: id, keywords: 'node', icon: Server, hint: i < 9 ? String(i + 1) : undefined, run: go(paths.node(id)) });
      for (const t of NODE_TABS) {
        if (t.id === 'summary') continue;
        cmds.push({ id: `node-${id}-${t.id}`, group: 'Nodes', label: `${id} › ${t.label}`, icon: Server, run: go(paths.node(id, t.id)) });
      }
    });
    cmds.push(
      { id: 'act-theme', group: 'Actions', label: `Switch to ${resolveTheme(nextTheme(theme)) === 'dark' ? 'dark' : 'light'} appearance`, keywords: 'appearance dark light mode toggle', icon: SunMoon, hint: 'T', run: () => { cycleTheme(); } },
      { id: 'act-transparency', group: 'Actions', label: reduceTransparency ? 'Turn off reduced transparency' : 'Reduce transparency', keywords: 'blur opaque accessibility', icon: Blend, run: () => { setPrefs({ reduceTransparency: !reduceTransparency }); } },
      { id: 'act-wall', group: 'Actions', label: 'Enter wall mode', keywords: 'fullscreen display tv', icon: Monitor, hint: 'W', run: go(paths.wall) },
      { id: 'act-sidebar', group: 'Actions', label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', icon: PanelLeft, run: () => { setPrefs({ sidebarCollapsed: !collapsed }); } },
      { id: 'act-shortcuts', group: 'Actions', label: 'Keyboard shortcuts', keywords: 'help keys', icon: Keyboard, hint: '?', run: () => { setHelp(true); } },
      { id: 'act-single-keys', group: 'Actions', label: singleKeys ? 'Turn off single-key shortcuts' : 'Turn on single-key shortcuts', keywords: 'keyboard keys speech accessibility', icon: Keyboard, run: () => { setPrefs({ singleKeyShortcuts: !singleKeys }); } },
    );
    return cmds;
  }, [order, theme, reduceTransparency, collapsed, singleKeys, navigate, close, setPrefs, cycleTheme, setHelp]);
}

/** ⌘K / Ctrl+K palette: combobox + listbox with grouped options and fuzzy filtering. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPalette = useUi((s) => s.setPalette);
  const close = useMemo(() => () => { setPalette(false); }, [setPalette]);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog open={open} onClose={close} title="Command palette" hideTitle size="md" initialFocus={inputRef} className="palette">
      {/* Mounted only while open, so the query starts empty each time. */}
      <PaletteBody close={close} inputRef={inputRef} />
    </Dialog>
  );
}

function PaletteBody({ close, inputRef }: { close: () => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const commands = useCommands(close);
  const singleKeys = usePrefs((s) => s.singleKeyShortcuts); // every hint is a single-key shortcut
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const optId = (id: string) => `${listId}-${id}`;

  const results = useMemo(() => fuzzyFilter(commands, query, (c) => `${c.label} ${c.keywords ?? ''} ${c.group}`), [commands, query]);
  const groups = useMemo(() => {
    const g = new Map<Command['group'], Command[]>();
    for (const c of results) g.set(c.group, [...(g.get(c.group) ?? []), c]);
    return [...g.entries()];
  }, [results]);
  // Options in display order (grouped), so arrow keys follow what is on screen.
  const flat = useMemo(() => groups.flatMap(([, cs]) => cs), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const currentId = current ? optId(current.id) : undefined;

  useEffect(() => {
    if (currentId) document.getElementById(currentId)?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(current);
    }
  };

  return (
    <>
      <div className="palette__search">
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          className="palette__input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={currentId}
          aria-label="Search views, nodes and actions"
          placeholder="Search views, nodes and actions…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
        <Kbd>esc</Kbd>
      </div>
      <ul id={listId} role="listbox" aria-label="Results" className="palette__list">
        {groups.map(([group, cs], gi) => (
          <li key={group} role="presentation">
            {/* Index-based id: group names contain spaces, which would split an IDREF list. */}
            <div className="palette__group" id={`${listId}-g${gi}`} role="presentation">{group}</div>
            <ul role="group" aria-labelledby={`${listId}-g${gi}`} className="palette__options">
              {cs.map((c) => {
                const selected = c === current;
                const Icon = c.icon;
                return (
                  // Options are operated through the combobox (aria-activedescendant); clicks are a mouse convenience.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <li
                    key={c.id}
                    id={optId(c.id)}
                    role="option"
                    aria-selected={selected}
                    className={`palette__option${selected ? ' is-active' : ''}`}
                    onPointerMove={() => { if (!selected) setActive(flat.indexOf(c)); }}
                    onClick={() => { run(c); }}
                  >
                    <Icon className="palette__icon" aria-hidden="true" />
                    <span className="palette__label">{c.label}</span>
                    {c.hint && singleKeys ? <span className="palette__hint" aria-hidden="true">{c.hint.split(' ').map((k) => <Kbd key={k}>{k}</Kbd>)}</span> : null}
                    {selected ? <CornerDownLeft className="palette__enter" aria-hidden="true" /> : null}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {flat.length === 0 ? (
        <p className="palette__empty" role="status">No matches for “{query}”</p>
      ) : (
        <p className="visually-hidden" role="status">{flat.length} results</p>
      )}
    </>
  );
}
