import { tempHeadroom } from './gpu';

/** Headroom to the GPU's slowdown/shutdown points; coloured only when close or over, and always said in words. */
export function TempFooter({ temp, slowdown, shutdown }: { temp: number | null; slowdown: number | null; shutdown: number | null }) {
  const h = tempHeadroom(temp, slowdown, shutdown);
  if (!h) return null;
  return <span className={h.level === 'ok' ? undefined : `nlevel-${h.level}`}>{h.text}</span>;
}
