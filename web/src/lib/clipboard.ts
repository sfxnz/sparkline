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
