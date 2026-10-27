import { render } from 'preact';

import { App } from './app.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root) render(<App />, root);

// The service worker only precaches the shell. Activity data is never cached:
// a dashboard showing yesterday's numbers as if they were live would be worse
// than one that says it cannot reach the daemon.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
