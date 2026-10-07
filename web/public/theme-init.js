// Apply the saved theme before first paint (no flash). Mirrors src/lib/prefs.ts. A file rather than an inline
// script, so the console's Content-Security-Policy can allow scripts from 'self' only.
(function () {
  var p = {};
  try { p = JSON.parse(localStorage.getItem('sparkline.prefs') || '{}') || {}; } catch (e) {}
  var t = p.theme === 'light' || p.theme === 'dark' ? p.theme
    : (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  var root = document.documentElement;
  root.setAttribute('data-theme', t);
  if (p.reduceTransparency) root.setAttribute('data-reduce-transparency', '');
})();
