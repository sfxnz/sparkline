import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Global styles first: component CSS must come later in the cascade so it can override the material utilities.
import './design/global.css';
import { App } from './app/App';
import { reloadOnStaleBuild } from './app/staleBuild';
import { captureSignInLink } from './lib/signInLink';

captureSignInLink(); // first: a sign-in link's token leaves the address bar before anything reads the address
reloadOnStaleBuild();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
