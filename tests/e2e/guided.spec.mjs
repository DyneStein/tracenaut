import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The guided experience, validated against the questions a beginner should be able to
 * answer with TraceNaut. Everything runs against the real demo app, daemon and agent.
 */

const session = () => JSON.parse(readFileSync(path.join(process.env.TRACENAUT_E2E_HOME, 'daemon.json'), 'utf8'));

test.beforeAll(async () => {
  await expect
    .poll(async () => {
      const s = session();
      const res = await fetch(`http://127.0.0.1:${s.port}/api/status`, { headers: { 'x-tracenaut-token': s.token } });
      return (await res.json()).agents.length;
    }, { timeout: 20_000 })
    .toBe(1);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('tracenaut:mode'));
});

const panel = (page) => page.locator('tracenaut-root .panel');
const signInButton = (page) => page.getByRole('button', { name: 'Sign in', exact: true });
const stepNamed = (page, title) => panel(page).locator('.step', { has: page.locator('.step-title', { hasText: title }) });
const card = (page) => page.locator('tracenaut-root .concept');

async function exploreSignIn(page) {
  await page.goto('/');
  await signInButton(page).click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await expect(panel(page).locator('.j-question')).toHaveText('What happens when you click “Sign in”?');
}

async function openStep(page, title) {
  const s = stepNamed(page, title).first();
  await s.locator('.step-main').click();
  await expect(s.locator('.detail')).toBeVisible();
  return s;
}

test('Q1 · What happens when I click this button? A plain journey, behaviour first', async ({ page }) => {
  await exploreSignIn(page);
  const p = panel(page);
  await expect(p.locator('.mode-switch .on')).toHaveText('Guided');
  // The answer comes first, in one sentence; the full explanation is one click away.
  await expect(p.locator('.j-headline')).toHaveText('Clicking it submits its form and sends email and password to the server.');
  await expect(p.locator('.hero-element .replica')).toHaveText('Sign in');
  await expect(p.locator('.j-summary')).toHaveCount(0);
  await p.getByRole('button', { name: 'Full explanation' }).click();
  await expect(p.locator('.j-summary')).toContainText('The browser then sends a POST /api/auth/login request with email and password.');
  await expect(p.locator('.zone-label')).toHaveText(['In your browser', 'On the server', 'In the database', 'In your browser']);
  await expect(p.locator('.step-title')).toHaveText([
    'You click “Sign in”',
    "The LoginForm component's code runs",
    'App code prepares the request',
    'Sends a request to the server',
    'The server receives it',
    "The server's code handles it",
    'Reads and writes data in the database',
    'The server answers',
    'The page updates',
  ]);
  // No code is shown until the student asks for it.
  await expect(p.locator('.code')).toHaveCount(0);
});

test('Q2 · Which programming language is responsible for this part?', async ({ page }) => {
  await exploreSignIn(page);
  // Each place lists its technologies once; each chip says what kind of thing it is.
  await expect(panel(page).locator('.zone.z-database .zone-head .tech-chip')).toHaveText(['SQL', 'SQLite', 'node:sqlite']);
  await expect(panel(page).locator('.zone.z-database .zone-head .tech-chip').first()).toHaveAttribute('aria-label', 'SQL, Programming language');
  await expect(panel(page).locator('.zone.z-database .zone-head .tech-chip').nth(1)).toHaveAttribute('aria-label', 'SQLite, Database');
  const server = await openStep(page, "The server's code handles it");
  await expect(server.locator('.detail-tech .tech-chip', { hasText: /^JavaScript$/ })).toHaveAttribute('aria-label', 'JavaScript, Programming language');

  // Languages, frameworks and runtimes are distinguished, with the evidence behind each.
  await panel(page).locator('.zone.z-browser .zone-head .tech-chip', { hasText: 'TSX' }).click();
  await expect(card(page).locator('.kind-tag')).toHaveText('Programming language');
  await expect(card(page)).toContainText('How TraceNaut knows');
  await expect(card(page)).toContainText('LoginForm.tsx is a .tsx file and contains JSX tags');
  await panel(page).locator('.zone.z-server .zone-head .tech-chip', { hasText: 'Express' }).click();
  await expect(card(page).locator('.kind-tag')).toHaveText('Framework');
  const entry = await openStep(page, 'The server receives it');
  await entry.locator('.detail-tech .tech-chip', { hasText: 'Node.js' }).click();
  await expect(card(page).locator('.kind-tag')).toHaveText('Runtime');
  await expect(card(page).locator('.concept-name')).toHaveText('Node.js');
});

test('Q3 · What does this unfamiliar syntax or term mean?', async ({ page }) => {
  await exploreSignIn(page);
  const ui = await openStep(page, "The LoginForm component's code runs");
  // Terms in explanations are hoverable…
  await ui.locator('.detail-summary .term', { hasText: 'React context' }).hover();
  await expect(card(page).locator('.concept-name')).toHaveText('React context');
  // …and so is notation inside real code.
  await ui.getByRole('button', { name: /Show the code/ }).click();
  const awaitKeyword = ui.locator('.syn[data-concept="async-await"]').first();
  await expect(awaitKeyword).toBeVisible();
  await awaitKeyword.hover();
  await expect(card(page).locator('.concept-name')).toHaveText('async / await');
  await expect(card(page).locator('.kind-tag')).toHaveText('Syntax');
});

test('Q4 · Why is this function necessary? Its role comes from what it actually does', async ({ page }) => {
  await exploreSignIn(page);
  const server = await openStep(page, "The server's code handles it");
  await expect(server.locator('.detail-summary')).toContainText('It asks the database to read users and add to sessions.');
  await expect(server.locator('.detail-summary')).toContainText('It can stop with an error (AuthError).');
  const verify = server.locator('.fn-chip', { hasText: 'verifyCredentials' });
  await expect(verify).toHaveAttribute('title', /Runs because post\('\/login'\) callback calls it · receives email, password/);
});

test('Q5 · How does the frontend communicate with the backend?', async ({ page }) => {
  await exploreSignIn(page);
  const req = await openStep(page, 'Sends a request to the server');
  await expect(req.locator('.detail-summary')).toContainText('The browser sends an HTTP POST request to the address /api/auth/login. It carries email and password in the request body, written as JSON.');
  await req.getByRole('button', { name: 'Show the code on both sides' }).click();
  await expect(req.locator('.anchor-label')).toHaveText(['Browser side: the request is made here', 'Server side: the route that receives it']);
  await expect(req.locator('.anchor .code-head .loc')).toHaveText(['web/src/api/auth.ts', 'server/routes/auth.js']);
  const answer = await openStep(page, 'The server answers');
  await expect(answer.locator('.j-fact')).toHaveText([/200 OK\s*sends user/, /401 Unauthorized\s*sends error/]);
});

test('Q6 · Which technology handles the next operation?', async ({ page }) => {
  await exploreSignIn(page);
  const p = panel(page);
  // Crossings name the protocol that carries them.
  await expect(stepNamed(page, 'Sends a request to the server').locator('.mini-chip')).toHaveText(['HTTP', 'JSON']);
  // The Layers view shows the places and the connections between them.
  await p.getByRole('tab', { name: 'Layers' }).click();
  await expect(p.locator('.layer-label b')).toHaveText(['Your element', 'In your browser', 'On the server', 'In the database']);
  await expect(p.locator('.link-pill')).toHaveText(['↓ submits the form', '↓ POST /api/auth/login', '↑ answers', '↩ then: the page updates', '↓ SQL · read users · add to sessions']);
  // The two possible answers are drawn as branches, and the server layer lists what runs before the route.
  await expect(p.locator('.branch')).toHaveText(['200 OK', '401 Unauthorized']);
  await expect(p.locator('.branch.bad')).toHaveText('401 Unauthorized');
  await expect(p.locator('.mw-chip')).toHaveText(['express.json()', 'route']);
  // The request→route link is only likely, so its connection is drawn as likely too.
  await expect(p.locator('.link-pill', { hasText: 'POST /api/auth/login' })).toHaveClass(/ev-inferred/);
  await p.locator('.link-pill', { hasText: 'SQL' }).click();
  await expect(p.locator('.detail-card')).toContainText('Reads and writes data in the database');
  await p.locator('.layer-row', { hasText: 'On the server' }).click();
  await expect(p.locator('.layer-steps button')).toHaveText(['The server receives it', "The server's code handles it"]);
  await p.locator('.layer-steps button', { hasText: "The server's code handles it" }).click();
  await expect(stepNamed(page, "The server's code handles it")).toHaveClass(/open/);
});

test('Q7 · Where can I inspect the actual implementation?', async ({ page }) => {
  await exploreSignIn(page);
  const server = await openStep(page, "The server's code handles it");
  await server.locator('.fn-chip', { hasText: 'findUserByEmail' }).click();
  await expect(server.locator('.anchor .code-head .loc').first()).toHaveText('server/db/usersRepo.js');
  await server.getByRole('button', { name: 'Technical details ›' }).click();
  await expect(panel(page).locator('.title')).toHaveText('findUserByEmail');
  await expect(panel(page).locator('.row', { hasText: 'SELECT users' })).toBeVisible();
});

test('Q8 · Which relationships were observed, and which are only possible?', async ({ page }) => {
  await exploreSignIn(page);
  const p = panel(page);
  await expect(p.locator('.j-basis')).toContainText('From reading the code · 2 likely links');
  await expect(stepNamed(page, 'The server receives it')).toHaveClass(/ev-inferred/);
  await expect(p.locator('.step.ev-runtime')).toHaveCount(0);

  await page.getByLabel('Password').fill('analytical');
  await p.locator('.watch-btn').click();
  await expect(p.locator('.j-armed')).toContainText('Now use the page');
  await signInButton(page).click();
  await expect(p.locator('.j-question')).toHaveText('What happened when you clicked “Sign in”?', { timeout: 20_000 });

  await expect(p.locator('.j-basis')).toContainText('Recorded just now · 3 likely links confirmed');
  await expect(p.locator('.step:not(.ev-runtime)')).toHaveCount(0);
  await expect(stepNamed(page, 'The server received it').first().locator('.step-tag')).toHaveText('Confirmed');
  const login = stepNamed(page, 'Sent a request to the server').first();
  await expect(login.locator('.step-sub')).toHaveText('POST /api/auth/login');
  // The tasks request only appears when the app really runs.
  const tasks = stepNamed(page, 'Sent a request to the server').nth(1);
  await expect(tasks.locator('.step-sub')).toHaveText('GET /api/tasks');
  await expect(tasks.locator('.step-tag')).toHaveText('Only seen running');
  await expect(stepNamed(page, 'After the redraw, an effect sends a request')).toBeVisible();
  const db = await openStep(page, 'Reads and writes data in the database');
  await expect(db.locator('.j-fact').first()).toContainText('SELECT id, email, name, password_hash FROM users WHERE email = ?');
  await expect(db.locator('.j-fact').first()).toContainText('(1 row)');
  await expect(p).not.toContainText('analytical');

  // In Layers, each recorded request gets its own lane, in the order they were sent.
  await p.getByRole('tab', { name: 'Layers' }).click();
  await expect(p.locator('.lane-no')).toHaveText(['Request 1', 'Request 2']);
  await expect(p.locator('.lanes').first().locator('.link-pill.ev-runtime', { hasText: '↓' })).toHaveText(['↓ POST /api/auth/login', '↓ GET /api/tasks']);
});

test('a wrong password takes a different path, and the journey shows it', async ({ page }) => {
  await exploreSignIn(page);
  const p = panel(page);
  await page.getByLabel('Password').fill('not-the-password');
  await p.locator('.watch-btn').click();
  await signInButton(page).click();
  await expect(p.locator('.j-question')).toHaveText('What happened when you clicked “Sign in”?', { timeout: 20_000 });
  await expect(stepNamed(page, 'The server answered').locator('.step-sub')).toHaveText('401 Unauthorized');
  // Starting a session is in the code but did not run this time.
  await expect(p.locator('.j-missed')).toContainText("In the code, but didn't run this time");
  await expect(p.locator('.j-missed')).toContainText("Part of “The server's code handles it” · startSession, insertSession");
  await expect(p.locator('.j-missed')).toContainText('add to sessions');
  const db = await openStep(page, 'Reads from the database');
  await expect(db.locator('.j-fact')).toHaveCount(1);
});

test('unknown elements and Technical mode', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  await page.evaluate(() => {
    const el = document.createElement('div');
    el.id = 'foreign';
    el.textContent = 'Injected by a third-party script';
    el.style.cssText = 'position:fixed;left:20px;bottom:20px;padding:10px;background:#fee';
    document.body.appendChild(el);
  });
  await page.locator('#foreign').click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await expect(panel(page).locator('.j-headline')).toContainText("TraceNaut can't tell");

  await signInButton(page).click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await panel(page).getByRole('radio', { name: 'Technical' }).click();
  await expect(panel(page).locator('.handler .event')).toHaveText('onSubmit');
  await panel(page).getByRole('radio', { name: 'Guided' }).click();
  await expect(panel(page).locator('.j-question')).toBeVisible();
});

// ---------------------------------------------------------------- layout guarantees

for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
  test(`everything stays reachable at ${viewport.width}×${viewport.height}, with every step and code view open`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await exploreSignIn(page);
    const p = panel(page);
    const n = await p.locator('.step-main').count();
    for (let i = 0; i < n; i++) await p.locator('.step-main').nth(i).click();
    const codeButtons = p.locator('.soft-btn', { hasText: /Show the code/ });
    while (await codeButtons.count()) await codeButtons.first().click();
    await expect(p.locator('.anchor .code').first()).toBeVisible();
    const report = await p.evaluate((panelEl) => {
      const body = panelEl.querySelector('.body');
      const pr = panelEl.getBoundingClientRect();
      const wide = [...panelEl.querySelectorAll('*')].filter((el) => !el.closest('.code-scroll') && el.getBoundingClientRect().right > pr.right + 1).map((el) => el.className);
      const nested = [...panelEl.querySelectorAll('*')].filter((el) => el !== body && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1).map((el) => el.className);
      body.scrollTop = body.scrollHeight;
      const last = [...body.querySelectorAll('.step')].pop().getBoundingClientRect();
      return { wide, nested, lastReachable: last.bottom <= body.getBoundingClientRect().bottom + 1, panelFits: pr.height <= innerHeight && pr.right <= innerWidth };
    });
    expect(report.wide).toEqual([]);
    expect(report.nested).toEqual([]);
    expect(report.lastReachable).toBe(true);
    expect(report.panelFits).toBe(true);
  });
}

test('the "more below" cue appears while content continues, and goes at the end', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await exploreSignIn(page);
  const p = panel(page);
  await openStep(page, 'Sends a request to the server');
  await expect(page.locator('tracenaut-root .more-below')).toBeVisible();
  await p.locator('.body').evaluate((b) => (b.scrollTop = b.scrollHeight));
  await expect(page.locator('tracenaut-root .more-below')).toHaveCount(0);
});

test('concept cards always fit inside the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await exploreSignIn(page);
  const p = panel(page);
  await p.getByRole('button', { name: 'Full explanation' }).click();
  const req = await openStep(page, 'Sends a request to the server');
  await p.locator('.body').evaluate((b) => (b.scrollTop = b.scrollHeight));
  // the lowest term on screen: the worst case for placement
  const terms = req.locator('.detail-summary .term');
  await terms.last().click();
  const box = await card(page).boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  // a pinned card follows its term while the panel scrolls (staying beside it and inside the
  // window), and closes once the term is out of view
  const term = terms.last();
  await p.locator('.body').evaluate((b) => b.scrollBy(0, -60));
  await expect
    .poll(async () => {
      const [t, c] = [await term.boundingBox(), await card(page).boundingBox()];
      const gap = Math.min(Math.abs(c.y - (t.y + t.height)), Math.abs(t.y - (c.y + c.height)));
      return gap <= 8 && c.y >= 0 && c.y + c.height <= 720;
    })
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
});

test('on a narrow window the panel overlays the page instead of squeezing it', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await exploreSignIn(page);
  await expect(panel(page)).toHaveClass(/overlay/);
  const box = await panel(page).boundingBox();
  expect(box.width).toBeLessThanOrEqual(900 - 16);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).marginRight)).toBe('0px');
});

test('the journey can be used with the keyboard', async ({ page }) => {
  await exploreSignIn(page);
  const first = stepNamed(page, 'You click “Sign in”').locator('.step-main');
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(stepNamed(page, 'You click “Sign in”')).toHaveClass(/open/);
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(page.locator('tracenaut-root :focus')).toBeVisible();
});

// ---------------------------------------------------------------- motion and performance

const runningAnimations = (page) =>
  page.evaluate(() => document.querySelector('tracenaut-root').shadowRoot.getAnimations().filter((a) => a.playState === 'running').length);

test('nothing keeps animating once the panel is idle', async ({ page }) => {
  await exploreSignIn(page);
  await openStep(page, 'Sends a request to the server');
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.waitForTimeout(600);
  expect(await runningAnimations(page)).toBe(0);
});

test('with reduced motion, nothing animates at all', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await exploreSignIn(page);
  await panel(page).locator('.step-main').first().click();
  await panel(page).getByRole('button', { name: 'Full explanation' }).click();
  expect(await runningAnimations(page)).toBe(0);
});

test('opening a journey is quick and causes no long main-thread tasks', async ({ page }) => {
  await page.goto('/');
  await signInButton(page).waitFor();
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' });
  });
  const started = Date.now();
  await signInButton(page).click({ button: 'right', modifiers: ['Alt'] });
  await page.getByRole('menuitem', { name: /Inspect with TraceNaut/ }).click();
  await expect(panel(page).locator('.step')).toHaveCount(9);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(2500);
  // expanding and switching views stays fast too
  await panel(page).locator('.step-main').nth(3).click();
  await page.getByRole('tab', { name: 'Layers' }).click();
  await page.getByRole('tab', { name: 'Step by step' }).click();
  const long = await page.evaluate(() => window.__long.filter((d) => d > 100));
  expect(long).toEqual([]);
});
