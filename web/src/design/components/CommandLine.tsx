import { Check, Copy } from 'lucide-react';
import { useCopy } from '../copy';
import { Button, IconButton } from './Button';
import './CommandLine.css';

interface Props {
  /** What is shown and copied, exactly. Several lines make a block (a config snippet) with no prompt. */
  text: string;
  /** What the copy button copies, for its name: "Copy command", "Copy scrape config". */
  what?: string;
  /** Icon-only copy button, where the line has little room (the sign-in card). */
  compact?: boolean;
  /** The `$` before a single line. False for something that is pasted, not run (an address). */
  prompt?: boolean;
}

/** A word wider than its line breaks before a slash of a path when one fits there, and anywhere only after that. */
const breakable = (word: string) => word.split(/(?<=[^/:])(?=\/)/).flatMap((piece, i) => (i ? [<wbr key={i} />, piece] : [piece]));

/** One thing to run or paste, whole and selectable, with a copy button. It wraps instead of truncating, so the
 *  text on screen is always the text that works. A line wraps at its spaces: each word is a box that moves to the
 *  next line whole, and breaks inside only when it alone is wider than the line. */
export function CommandLine({ text, what = 'command', compact, prompt = true }: Props) {
  const { copied, copy } = useCopy();
  const block = text.includes('\n');
  const done = copied?.ok === true;
  const name = done ? `Copied ${what}` : `Copy ${what}`;
  const icon = done ? <Check /> : <Copy />;
  const onClick = () => { copy(what, text); };
  return (
    <div className={`cmd${block ? ' cmd--block' : ''}`}>
      {block ? (
        // Focusable so a snippet wider than its box scrolls with the keyboard.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <pre className="cmd__text" tabIndex={0} aria-label={what}><code>{text}</code></pre>
      ) : (
        <>
          {prompt ? <span className="cmd__prompt" aria-hidden="true">$</span> : null}
          <code className="cmd__text">{text.split(/( +)/).map((part, i) => (i % 2 ? part : <span key={i} className="cmd__word">{breakable(part)}</span>))}</code>
        </>
      )}
      {compact ? (
        <IconButton size="sm" variant="secondary" className={done ? 'is-copied' : undefined} aria-label={name} title={name} icon={icon} onClick={onClick} />
      ) : (
        <Button size="sm" className={done ? 'is-copied' : undefined} aria-label={name} icon={icon} onClick={onClick}>
          <span className="cmd__copy-label">{done ? 'Copied' : 'Copy'}</span>
        </Button>
      )}
      <span className="visually-hidden" role="status">
        {copied ? (copied.ok ? `Copied ${what}` : 'The browser blocked the clipboard. Select the text and copy it.') : ''}
      </span>
    </div>
  );
}
