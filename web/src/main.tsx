import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Global styles first: component CSS must come later in the cascade so it can override the material utilities.
import './design/global.css';
import { App } from './app/App';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
