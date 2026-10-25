// Relays the menu choice to the page. The page client already remembers which element
// was right-clicked. When TraceNaut is not active on this page (or frame), say so briefly
// instead of silently doing nothing.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== 'inspect' && message?.action !== 'trace') return;
  if (document.querySelector('tracenaut-root')) {
    window.postMessage({ source: 'tracenaut-extension', action: message.action }, window.location.origin);
    return;
  }
  toast(
    window !== window.top
      ? 'TraceNaut can’t inspect inside this embedded frame. Open the frame’s page on its own to inspect it.'
      : 'TraceNaut isn’t active on this page. Start it with `tracenaut start`, make sure the dev server uses the TraceNaut plugin, then reload.',
  );
});

function toast(text) {
  document.getElementById('tracenaut-extension-toast')?.remove();
  const host = document.createElement('div');
  host.id = 'tracenaut-extension-toast';
  // A shadow root keeps the page's styles away from the message and vice versa.
  const root = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.textContent = text;
  box.style.cssText =
    'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;' +
    'background:#1d2230;color:#f3f5fa;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px rgb(0 0 0 / 25%);';
  root.append(box);
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 6000);
}
