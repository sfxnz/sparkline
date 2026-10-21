// Dev gallery block (rendered by src/dev/gallery.tsx): the tool-calling evaluation in every fixture state at the app's
// content width (1128 px at a 1440 px window), so each can be checked and screenshotted in both themes without a
// console. Running states are anchored to the page's load time so their timers read true.
import { FIXTURES } from './fixtures';
import { ToolEvalSection } from './ToolEvalSection';

const LOADED = Date.now() / 1000;

const STATES: readonly [keyof typeof FIXTURES, string][] = [
  ['waiting', 'Before the first snapshot'],
  ['early', 'Running · early (Standard, 2 of 69)'],
  ['mid', 'Running · mid (Standard, 35 of 69, with a preflight warning)'],
  ['late', 'Running · late (All, 92 of 97, exclusions and safety violations so far)'],
  ['core', 'Running · Core (9 of 15)'],
  ['twoNodes', 'Running on two nodes'],
  ['done', 'Finished · clean (Standard 69)'],
  ['capped', 'Finished · exclusions and a safety cap (All 97)'],
  ['cancelled', 'Cancelled after 23 of 69'],
  ['ungraded', 'Failed · nothing could be graded (Core 15)'],
];

export function ToolEvalGallery() {
  return (
    <section aria-label="Tool-calling evaluation states" style={{ display: 'grid', gap: 48, marginTop: 24 }}>
      {STATES.map(([key, label]) => (
        <div key={key} data-te-state={key} style={{ display: 'grid', gap: 12, maxWidth: 1128 }}>
          <h2 className="t-eyebrow">Tool-calling evaluation · {label}</h2>
          <div className="view">
            <ToolEvalSection run={FIXTURES[key](LOADED)} spec={undefined} />
          </div>
        </div>
      ))}
    </section>
  );
}
