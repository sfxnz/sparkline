// Copy to the clipboard, and say that it happened.
import { useEffect, useRef, useState } from 'react';

/** Write `text` to the clipboard; the console is often served over plain http on the LAN, where the async clipboard
 * API is missing, so fall back to a hidden textarea and execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && 'clipboard' in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only way to copy outside a secure context
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export type Copied = { key: string; ok: boolean } | null;

/** Which copy just happened (for its button's "Copied" and the status line), cleared after a moment. */
export function useCopy() {
  const [copied, setCopied] = useState<Copied>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); }, []);
  const copy = (key: string, text: string) => {
    void copyText(text).then((ok) => {
      setCopied({ key, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { setCopied(null); }, 2000);
    });
  };
  return { copied, copy };
}
