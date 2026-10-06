import { Fragment } from 'react';

/** Render `backtick` spans in server-provided copy (Problem.fix etc.) as <code>. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}
