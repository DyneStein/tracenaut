// Renders an icon to a transparent PNG at a given size (used for the browser extension's
// icons; the in-page UI uses the SVGs directly).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const [name, size, out] = process.argv.slice(2);
const svg = readFileSync(new URL(`../../packages/assets/dist/icons/${name}.svg`, import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(size), height: Number(size) } });
await page.setContent(`<body style="margin:0;background:transparent"><img src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}" width="${size}" height="${size}"></body>`);
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
