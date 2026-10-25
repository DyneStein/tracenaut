import { test, expect } from '@playwright/test';

/**
 * Edge cases: failures of TraceNaut itself, failures of the app, unusual pages and
 * impatient use. Everything runs against the real demo app, daemon and agent; failures
 * are produced with Playwright's network interception.
 */

const DAEMON = 'http://127.0.0.1:4499';
const panel = (page) => page.locator('tracenaut-root .panel');
const signInButton = (page) => page.getByRole('button', { name: 'Sign in', exact: true });

// Errors thrown by TraceNaut's own client (the app's own failures are not its business).
let clientErrors = [];
test.beforeEach(async ({ page }) => {
  clientErrors = [];
  await page.addInitScript(() => localStorage.removeItem('tracenaut:mode'));
  page.on('pageerror', (err) => {
    // The app's own failed fetches pass through TraceNaut's fetch wrapper unchanged; they are not its errors.
    if (err.message === 'Failed to fetch') return;
    if (/client\.js|TraceNaut/.test(`${err.stack}\n${err.message}`)) clientErrors.push(err.message);
  });
});
test.afterEach(() => {
  expect(clientErrors).toEqual([]);
});

async function inspect(page, locator) {
  await locator.click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
}

test('daemon unreachable: a plain message and a retry that works once it is back', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  await page.route(`${DAEMON}/api/journey`, (route) => route.abort());
  await inspect(page, signInButton(page));
  const error = panel(page).locator('.error');
  await expect(error).toContainText('can’t reach its background program');
  await page.unroute(`${DAEMON}/api/journey`);
  await error.getByRole('button', { name: 'Try again' }).click();
  await expect(panel(page).locator('.j-question')).toHaveText('What happens when you click “Sign in”?');
});

test('daemon restarted (old access key): says to reload, without a useless retry', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  await page.route(`${DAEMON}/api/journey`, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Missing or invalid TraceNaut token"}' }));
  await inspect(page, signInButton(page));
  const error = panel(page).locator('.error');
  await expect(error).toContainText('Reload the page to reconnect');
  await expect(error.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

async function recordSignIn(page, password = 'analytical') {
  await page.goto('/');
  await inspect(page, signInButton(page));
  const p = panel(page);
  await expect(p.locator('.j-question')).toHaveText('What happens when you click “Sign in”?');
  await page.getByLabel('Password').fill(password);
  await p.locator('.watch-btn').click();
  await expect(p.locator('.j-armed')).toContainText('Now use the page');
  await signInButton(page).click();
  await expect(p.locator('.j-question')).toHaveText('What happened when you clicked “Sign in”?', { timeout: 20_000 });
  return p;
}

test('an aborted request is shown as "No answer came back"', async ({ page }) => {
  await page.route('**/api/tasks', (route) => route.abort());
  const p = await recordSignIn(page);
  const step = p.locator('.step', { has: page.locator('.step-title', { hasText: 'No answer came back' }) });
  await expect(step).toHaveCount(1);
  await expect(step.locator('.step-sub')).toHaveText('failed');
});

test('a server error is shown with its status, not as success', async ({ page }) => {
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  const p = await recordSignIn(page);
  await expect(p.locator('.step', { has: page.locator('.step-title', { hasText: 'The server answered' }) }).locator('.step-sub')).toHaveText(/^500 /);
});

test('sensitive query values are never recorded', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  const p = await (async () => {
    await inspect(page, signInButton(page));
    const p = panel(page);
    await page.getByLabel('Password').fill('analytical');
    await p.locator('.watch-btn').click();
    await expect(p.locator('.j-armed')).toContainText('Now use the page');
    // Code outside the app's instrumented files sends a request with a token in its address.
    await page.evaluate(() => document.addEventListener('click', () => fetch('/api/health?token=abc123secret&page=2'), { once: true, capture: true }));
    await signInButton(page).click();
    await expect(p.locator('.j-question')).toHaveText('What happened when you clicked “Sign in”?', { timeout: 20_000 });
    return p;
  })();
  await expect(p).toContainText('/api/health?token=•••&page=2');
  await expect(p).not.toContainText('abc123secret');
});

test('elements inside an open shadow root are targeted, not their host', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  await page.evaluate(() => {
    class FancyButton extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML = '<button id="inner">Shadow action</button>';
      }
    }
    customElements.define('fancy-button', FancyButton);
    document.body.prepend(document.createElement('fancy-button'));
  });
  await page.locator('fancy-button').locator('#inner').click({ button: 'right', modifiers: ['Alt'] });
  await expect(page.locator('tracenaut-root .menu-title')).toContainText('Shadow action');
});

test('on a phone-sized screen the panel overlays the page without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/');
  await inspect(page, signInButton(page));
  const p = panel(page);
  await expect(p.locator('.j-question')).toBeVisible();
  await expect(p).toHaveClass(/overlay/);
  const box = await p.boundingBox();
  expect(box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await p.getByRole('tab', { name: 'Layers' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('switching modes quickly and repeatedly settles on the last choice', async ({ page }) => {
  await page.goto('/');
  await inspect(page, signInButton(page));
  const p = panel(page);
  await expect(p.locator('.j-question')).toBeVisible();
  for (let i = 0; i < 6; i++) {
    await p.getByRole('radio', { name: 'Technical' }).click();
    await p.getByRole('radio', { name: 'Guided' }).click();
  }
  await p.getByRole('radio', { name: 'Technical' }).click();
  await expect(p).toHaveClass(/technical/);
  await expect(p.locator('.handler .event')).toHaveText('onSubmit');
});

test('a second inspection started before the first finishes wins, and Back returns to the first', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  // Slow the first answer down so the two inspections overlap.
  let first = true;
  await page.route(`${DAEMON}/api/journey`, async (route) => {
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 1200));
    }
    await route.continue();
  });
  await inspect(page, signInButton(page));
  await inspect(page, page.getByLabel('Email'));
  const p = panel(page);
  await expect(p.locator('.j-question')).not.toContainText('Sign in');
  await p.getByRole('button', { name: 'Back' }).click();
  await expect(p.locator('.j-question')).toHaveText('What happens when you click “Sign in”?');
});

test('the element replica never copies what was typed into a password field', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('hunter2-very-secret');
  await inspect(page, page.getByLabel('Password'));
  const p = panel(page);
  await expect(p.locator('.j-question')).toBeVisible();
  await p.getByRole('tab', { name: 'Layers' }).click();
  await expect(p.locator('.element-card')).toBeVisible();
  const html = await page.evaluate(() => document.querySelector('tracenaut-root').shadowRoot.innerHTML);
  expect(html).not.toContain('hunter2-very-secret');
});

test('an action that loads a whole new page is still recorded, and says where it stopped', async ({ page }) => {
  await page.goto('/');
  await inspect(page, signInButton(page));
  const p = panel(page);
  await expect(p.locator('.j-question')).toHaveText('What happens when you click “Sign in”?');
  // A plain link that reloads the page (as many logins and logouts do).
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '/?reloaded=1';
    a.textContent = 'Full reload';
    a.id = 'full-reload';
    document.body.prepend(a);
  });
  await p.locator('.watch-btn').click();
  await expect(p.locator('.j-armed')).toContainText('Now use the page');
  await page.locator('#full-reload').click();
  await page.waitForURL('**/?reloaded=1');
  const p2 = panel(page);
  await expect(p2.locator('.j-question')).toContainText('What happened', { timeout: 20_000 });
  await expect(p2.locator('.step', { has: page.locator('.step-title', { hasText: 'The browser loaded a new page' }) })).toHaveCount(1);
});

test('messages on a live WebSocket connection are counted, never read', async ({ page }) => {
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws) => ws.on('message', () => ws.send('reply-with-private-content')));
  try {
    await page.goto('/');
    await inspect(page, signInButton(page));
    const p = panel(page);
    await page.getByLabel('Password').fill('analytical');
    await page.evaluate((port) => {
      window.__ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
      return new Promise((r) => window.__ws.addEventListener('open', r));
    }, wss.address().port);
    await p.locator('.watch-btn').click();
    await expect(p.locator('.j-armed')).toContainText('Now use the page');
    await page.evaluate(() => document.addEventListener('click', () => window.__ws.send('secret-message'), { once: true, capture: true }));
    await signInButton(page).click();
    await expect(p.locator('.j-question')).toHaveText('What happened when you clicked “Sign in”?', { timeout: 20_000 });
    const step = p.locator('.step', { has: page.locator('.step-title', { hasText: 'Messages over a live connection' }) });
    await expect(step.locator('.step-sub')).toContainText('1 sent · 1 received');
    await expect(p).not.toContainText('secret-message');
    await expect(p).not.toContainText('reply-with-private-content');
    // It is not counted as one of the browser's requests.
    await expect(p.locator('.j-headline')).toContainText('then 1 more request followed');
  } finally {
    wss.close();
  }
});
