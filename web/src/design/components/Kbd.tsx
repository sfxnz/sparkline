import './Kbd.css';

/** A keyboard key. `mod` renders ⌘ on Apple platforms and Ctrl elsewhere. */
export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}
