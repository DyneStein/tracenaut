import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The native context-menu item itself cannot be clicked by automation, so this test
// triggers the exact message the menu handler sends, from the extension's service worker.
test('the browser extension relays "Inspect with TraceNaut" to the page', async () => {
  const extension = path.resolve('packages/extension/dist');
  const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'tn-ext-')), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1400, height: 900 },
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await context.addInitScript(() => localStorage.setItem('tracenaut:mode', 'technical'));
    const page = await context.newPage();
    await page.goto('http://localhost:5273/');
    const button = page.getByRole('button', { name: 'Sign in' });
    await button.waitFor();
    // A normal right-click (the page client remembers the target), then the menu choice.
    await button.click({ button: 'right' });
    await page.keyboard.press('Escape');
    await worker.evaluate(async () => {
      // Without the "tabs" permission URLs are hidden, so pick the active tab (the test page).
      const [tab] = await chrome.tabs.query({ active: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'inspect' });
    });
    const panel = page.locator('tracenaut-root .panel');
    await expect(panel.locator('.handler .event')).toHaveText('onSubmit');
    await expect(panel.locator('.code-head .loc')).toHaveText('web/src/components/LoginForm.tsx');

    // On a local page without TraceNaut, the menu explains instead of doing nothing.
    const other = await context.newPage();
    await other.goto('http://127.0.0.1:4499/api/health');
    await other.bringToFront();
    await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'inspect' });
    });
    await expect(other.locator('#tracenaut-extension-toast [role=status]')).toContainText('TraceNaut isn’t active on this page');
  } finally {
    await context.close();
  }
});
