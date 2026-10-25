// Must run before the application's modules: installs the probe runtime and request observers.
import { recorder } from './runtime.js';
import { locate } from './adapters.js';
import { config } from './api.js';
import { render } from 'preact';
import { App } from './ui/App.js';
import css from './ui/styles.css';

recorder.locate = locate;

function mount() {
  if (!config || document.querySelector('tracenaut-root')) return;
  const host = document.createElement('tracenaut-root');
  // Open shadow root: isolates styles both ways, still reachable by test tooling.
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  document.documentElement.appendChild(host);
  render(<App host={host} />, mountPoint);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
