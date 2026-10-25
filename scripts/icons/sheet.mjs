// Renders a contact sheet of the icon family (dark and light panels, several sizes) to PNG.
import { chromium } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
const dir = process.env.ICON_DIR ?? new URL('../../packages/client/src/icons/', import.meta.url).pathname;
const out = process.argv[2] ?? 'icons-sheet.png';
const names = readdirSync(dir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
const uri = (n) => `data:image/svg+xml;utf8,${encodeURIComponent(readFileSync(dir + n + '.svg', 'utf8'))}`;
const row = (bg, fg) => `<div style="background:${bg};color:${fg};padding:14px 16px;display:grid;grid-template-columns:repeat(${names.length},1fr);gap:8px">${names
  .map((n) => `<div style="display:flex;flex-direction:column;align-items:center;gap:6px"><img src="${uri(n)}" width="56" height="56"><img src="${uri(n)}" width="32" height="32"><img src="${uri(n)}" width="22" height="22"><span style="font:10px ui-monospace,Menlo">${n}</span></div>`)
  .join('')}</div>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: names.length * 74 + 40, height: 400 }, deviceScaleFactor: 2 });
await page.setContent(`<body style="margin:0">${row('#111318', '#c9cdd8')}${row('#ffffff', '#3b4252')}</body>`);
await page.waitForTimeout(200);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
