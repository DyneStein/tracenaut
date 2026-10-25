import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const session = () => JSON.parse(readFileSync(path.join(process.env.TRACENAUT_E2E_HOME, 'daemon.json'), 'utf8'));

async function daemon(pathname) {
  const s = session();
  const res = await fetch(`http://127.0.0.1:${s.port}${pathname}`, { headers: { 'x-tracenaut-token': s.token } });
  return res.json();
}

test.beforeAll(async () => {
  // The backend agent connects asynchronously; wait until the daemon sees it.
  await expect.poll(async () => (await daemon('/api/status')).agents.length, { timeout: 20_000 }).toBe(1);
});

const panel = (page) => page.locator('tracenaut-root .panel');

// These tests cover the inspector, which is the Technical mode of the panel.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tracenaut:mode', 'technical'));
});

async function inspect(page, locator) {
  await locator.click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await expect(panel(page).locator('.section-title', { hasText: 'When you interact' })).toBeVisible();
}

async function signIn(page) {
  await page.getByLabel('Password').fill('analytical');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your tasks' })).toBeVisible();
}

/** Expand the row whose label is exactly `label` inside `scope`. */
async function expand(scope, label) {
  const row = scope.locator('.row', { has: scope.page().locator('.row-label', { hasText: new RegExp(`^${escape(label)}$`) }) }).first();
  await row.locator('.chev').click();
  return row.locator('xpath=..');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('the daemon and client are attached to the running app', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('tracenaut-root')).toHaveCount(1);
  // Normal right-click is untouched: no TraceNaut menu without Alt.
  await page.getByRole('button', { name: 'Sign in' }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Inspect with TraceNaut/ })).toHaveCount(0);
});

test('inspecting the Sign in button maps it to source and its submit handler chain', async ({ page }) => {
  await page.goto('/');
  await inspect(page, page.getByRole('button', { name: 'Sign in' }));
  const p = panel(page);

  // The clicked <button> is the root of the reusable Button component, so the usage site is shown first.
  await expect(p.locator('.section-title').filter({ hasText: '<Button> usage' })).toBeVisible();
  await expect(p.locator('.code-head .loc')).toHaveText('web/src/components/LoginForm.tsx');
  await expect(p.locator('.line.focus .ln').first()).toHaveText('38');
  await expect(p.locator('.crumb.on')).toHaveText('Button');

  // The handler sits on the ancestor <form>; it is confirmed live via the React props.
  const handler = p.locator('.handler').first();
  await expect(handler.locator('.event')).toHaveText('onSubmit');
  await expect(handler).toContainText('form submission triggered by this control');
  await expect(handler).toContainText('attached now');
  await expect(handler.locator('.row').first()).toContainText('handleSubmit');
  await expect(handler.locator('.row .badge').first()).toHaveText('static');

  // Follow it: handleSubmit → signIn (inferred through context) → login → POST /api/auth/login.
  const h1 = await expand(handler, 'handleSubmit');
  const signInRow = h1.locator('.row', { hasText: 'signIn' }).first();
  await expect(signInRow.locator('.badge')).toHaveText('inferred');
  const h2 = await expand(h1, 'signIn');
  const h3 = await expand(h2, 'login');
  const req = h3.locator('.row', { hasText: 'POST /api/auth/login' }).first();
  await expect(req).toBeVisible();
  await expect(req.locator('.badge')).toHaveText('static');
  // State setters and library calls are kept out of the way.
  await expect(h1.locator(':scope > ul.tree > li.uses')).toContainText('setSubmitting');
});

test('a request node links to the backend route and its handler', async ({ page }) => {
  await page.goto('/');
  await inspect(page, page.getByRole('button', { name: 'Sign in' }));
  const p = panel(page);
  const h1 = await expand(p.locator('.handler').first(), 'handleSubmit');
  const h2 = await expand(h1, 'signIn');
  const h3 = await expand(h2, 'login');
  await h3.locator('.row-label', { hasText: 'POST /api/auth/login' }).click();

  await expect(p.locator('.title')).toHaveText('POST /api/auth/login');
  await expect(p.locator('.facts')).toContainText('Through');
  await expect(p.locator('.facts')).toContainText('request()');
  const route = p.locator('.row', { hasText: 'POST /api/auth/login' }).filter({ has: page.locator('.k-http-route') });
  await expect(route.locator('.badge')).toHaveText('inferred');
  await route.locator('.row-label').click();

  await expect(p.locator('.facts')).toContainText("authRouter.post('/login')");
  await expect(p.locator('.code-head .loc')).toHaveText('server/routes/auth.js');
  const handlerRow = p.locator('.row', { hasText: "post('/login') callback" });
  await expect(handlerRow).toBeVisible();
  const children = await expand(p.locator('.section').last().locator('xpath=..'), "post('/login') callback");
  await expect(children.locator('.row', { hasText: 'verifyCredentials' })).toBeVisible();

  // Back navigation returns to the request node.
  await p.getByTitle('Back').click();
  await expect(p.locator('.title')).toHaveText('POST /api/auth/login');
});

test('trace next action records the real execution across browser, server and database', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Password').fill('analytical');
  await page.locator('tracenaut-root .launcher').click();
  const p = panel(page);
  await p.getByRole('button', { name: 'Watch it happen' }).click();
  await expect(p.getByText('Watching for your next action')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(p.getByText('What ran')).toBeVisible({ timeout: 20_000 });

  await expect(p.locator('.title')).toContainText('submit');
  // Observed frontend call chain, in causal order.
  for (const fn of ['handleSubmit', 'signIn', 'login', 'request']) {
    await expect(p.locator('.row-label', { hasText: new RegExp(`^${fn}$`) }).first()).toBeVisible();
  }
  const login = p.locator('.req', { hasText: '/api/auth/login' });
  await expect(login.locator('.status')).toHaveText('200');
  await expect(login.locator('.server-head')).toContainText('POST /api/auth/login');
  for (const fn of ['verifyCredentials', 'findUserByEmail', 'passwordMatches', 'startSession', 'insertSession']) {
    await expect(login.locator('.row-label', { hasText: new RegExp(`^${fn}$`) })).toBeVisible();
  }
  await expect(login.locator('.sql').first()).toContainText('SELECT id, email, name, password_hash FROM users WHERE email = ?');
  // No parameter values (the password, the email) are captured anywhere.
  await expect(p).not.toContainText('analytical');

  // The follow-up request made after the re-render is attributed to the effect that issued it.
  // (React StrictMode runs effects twice in development, and the trace shows both requests.)
  const tasks = p.locator('.req', { hasText: '/api/tasks' }).first();
  await expect(tasks.locator('.server-head')).toContainText('GET /api/tasks');
  await expect(tasks.locator('.row-label', { hasText: /^requireAuth$/ })).toBeVisible();
  await expect(p.locator('.renders')).toContainText('TaskBoard');
});

test('handlers passed through props and {...spread} resolve to their real definition', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  await inspect(page, page.getByRole('button', { name: 'Delete Trace adding a task end to end' }));
  const p = panel(page);
  const handler = p.locator('.handler').first();
  await expect(handler.locator('.event')).toHaveText('onClick');
  await expect(handler).toContainText('attached now');
  await expect(handler.locator('.hops')).toContainText('{...spread} (onClick) ← <Button> at web/src/components/TaskItem.tsx');
  await expect(handler.locator('.row').first()).toContainText('onClick handler');

  // The inline arrow calls the onDelete prop; the only usage passes removeTask from useTasks().
  const h1 = await expand(handler, 'onClick handler');
  const removeRow = h1.locator('.row', { hasText: 'removeTask' }).first();
  await expect(removeRow.locator('.badge')).toHaveText('inferred');
  const h2 = await expand(h1, 'removeTask');
  const h3 = await expand(h2, 'deleteTask');
  const del = h3.locator('.row', { hasText: 'DELETE /api/tasks/{id}' });
  await expect(del).toBeVisible();
  await expect(del.locator('.badge')).toHaveText('static');
});

test('adding a task is traced through validation and SQL', async ({ page }) => {
  await page.goto('/');
  await signIn(page);
  const title = `Traced task ${Date.now()}`;
  await page.getByPlaceholder('What needs doing?').fill(title);
  await page.locator('tracenaut-root .launcher').click();
  const p = panel(page);
  await p.getByRole('button', { name: 'Watch it happen' }).click();
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(p.getByText('What ran')).toBeVisible({ timeout: 20_000 });

  // submit → addTask (onCreate prop) → createTask → request → POST /api/tasks
  for (const fn of ['submit', 'addTask', 'createTask', 'request']) {
    await expect(p.locator('.row-label', { hasText: new RegExp(`^${fn}$`) }).first()).toBeVisible();
  }
  const post = p.locator('.req', { hasText: 'POST' }).filter({ hasText: '/api/tasks' });
  await expect(post.locator('.status')).toHaveText('201');
  await expect(post.locator('.server-head')).toContainText('POST /api/tasks');
  for (const fn of ['requireAuth', 'addTask', 'createTask', 'validateTitle', 'insertTask', 'toDto']) {
    await expect(post.locator('.row-label', { hasText: new RegExp(`^${fn}$`) }).first()).toBeVisible();
  }
  await expect(post.locator('.sql', { hasText: 'INSERT INTO tasks' })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
});

test('elements without source locations are reported honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  // An element created outside React and outside the instrumented source.
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'foreign';
    el.textContent = 'Injected by a third-party script';
    el.style.cssText = 'position:fixed;left:20px;bottom:20px;padding:10px;background:#fee';
    document.body.appendChild(el);
  });
  await page.locator('#foreign').click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await expect(panel(page)).toContainText('carries no TraceNaut source location');
  await expect(panel(page).locator('.handler')).toHaveCount(0);
});

test('clicking a call site in the code view navigates to its definition', async ({ page }) => {
  await page.goto('/');
  await inspect(page, page.getByRole('button', { name: 'Sign in' }));
  const p = panel(page);
  await p.locator('.handler .row-label', { hasText: 'handleSubmit' }).click();
  await expect(p.locator('.title')).toHaveText('handleSubmit');
  await p.locator('.code .mark', { hasText: 'signIn' }).click();
  await expect(p.locator('.title')).toHaveText('signIn');
  await expect(p.locator('.subtitle')).toContainText('web/src/hooks/useAuth.tsx');
  // "Used by" resolves the reverse relation on demand.
  await p.getByRole('button', { name: 'Find what calls this' }).click();
  await expect(p.locator('.section', { hasText: 'Used by' }).locator('.row-label', { hasText: 'AuthProvider' })).toBeVisible();
});
