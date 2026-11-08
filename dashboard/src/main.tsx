import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import { App } from './App.js';
import { LiveProvider } from './lib/live.js';

const el = document.getElementById('root');
if (!el) throw new Error('missing #root');

createRoot(el).render(
  <StrictMode>
    <LiveProvider>
      <App />
    </LiveProvider>
  </StrictMode>,
);
