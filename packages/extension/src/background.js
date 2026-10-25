// The extension only adds menu items. All analysis happens in the local daemon, and the
// in-page TraceNaut client (injected by the dev server) does the inspecting.
const LOCAL_PAGES = ['http://localhost/*', 'http://127.0.0.1/*'];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'tracenaut-inspect', title: 'Inspect with TraceNaut', contexts: ['all'], documentUrlPatterns: LOCAL_PAGES });
  chrome.contextMenus.create({ id: 'tracenaut-trace', title: 'TraceNaut: trace next action', contexts: ['all'], documentUrlPatterns: LOCAL_PAGES });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const action = info.menuItemId === 'tracenaut-trace' ? 'trace' : 'inspect';
  chrome.tabs.sendMessage(tab.id, { action }, { frameId: info.frameId ?? 0 });
});
