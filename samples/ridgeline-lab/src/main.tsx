/**
 * Browser entry for the Ridgeline lab.
 */

import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {App} from './ui/App.js';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Ridgeline lab: missing #root element.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
