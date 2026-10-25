// One-time (re)vendoring of official logos from Simple Icons, pinned to a version.
// Only slugs referenced by the registry are stored, with their license and guidelines.
//   node scripts/icons/vendor-logos.mjs
import { writeFileSync } from 'node:fs';
import { TECHNOLOGIES, EXCLUDED_LOGO_LICENSES } from '../../packages/assets/src/registry.mjs';

const VERSION = '16.35.0';
const base = `https://cdn.jsdelivr.net/npm/simple-icons@${VERSION}`;
const data = await (await fetch(`${base}/data/simple-icons.json`)).json();
const icons = Array.isArray(data) ? data : data.icons;
const bySlug = new Map(icons.map((i) => [i.slug, i]));
const out = { source: 'Simple Icons', version: VERSION, url: 'https://simpleicons.org', collectionLicense: 'CC0-1.0', logos: {} };
for (const slug of [...new Set(TECHNOLOGIES.map((t) => t.logo).filter(Boolean))].sort()) {
  const meta = bySlug.get(slug);
  if (!meta) throw new Error(`Simple Icons has no "${slug}"`);
  const license = meta.license?.type ?? null;
  if (license && EXCLUDED_LOGO_LICENSES.includes(license)) throw new Error(`${slug} is ${license}, which TraceNaut excludes`);
  const svg = await (await fetch(`${base}/icons/${slug}.svg`)).text();
  const path = /<path d="([^"]+)"/.exec(svg)?.[1];
  if (!path) throw new Error(`no path in ${slug}.svg`);
  out.logos[slug] = { title: meta.title, hex: meta.hex, path, source: meta.source, license: meta.license ?? null, guidelines: meta.guidelines ?? null };
}
writeFileSync(new URL('../../packages/assets/vendor/simple-icons.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(`vendored ${Object.keys(out.logos).length} logos from Simple Icons ${VERSION}`);
