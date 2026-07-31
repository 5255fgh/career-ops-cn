import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#root');

if (root === null) {
  throw new Error('找不到侧栏根节点。');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
