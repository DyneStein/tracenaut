// Builds packages/assets/dist/gallery.html: every TraceNaut asset at real sizes, the
// technology registry with honest support levels, and logo attribution.
//   node scripts/icons/gallery.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { TECHNOLOGIES, CONCEPT_ICONS, CATEGORIES } from '../../packages/assets/src/registry.mjs';
import { supportOf, LEVELS } from '../../packages/assets/src/support.mjs';

const dist = new URL('../../packages/assets/dist/', import.meta.url).pathname;
const vendor = JSON.parse(readFileSync(new URL('../../packages/assets/vendor/simple-icons.json', import.meta.url), 'utf8'));
const svg = (name) => readFileSync(`${dist}icons/${name}.svg`, 'utf8');
const uri = (name) => `data:image/svg+xml;utf8,${encodeURIComponent(svg(name))}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const brand = readdirSync(`${dist}icons`).filter((f) => f.startsWith('brand-')).map((f) => f.slice(0, -4));

const conceptCards = Object.entries(CONCEPT_ICONS)
  .map(([name, label]) => `<figure><img src="${uri(name)}" width="48" height="48" alt=""><img src="${uri(name)}" width="24" height="24" alt=""><figcaption><b>${esc(name)}</b><span>${esc(label)}</span></figcaption></figure>`)
  .join('');

const techSections = Object.entries(CATEGORIES)
  .map(([cat, title]) => {
    const rows = TECHNOLOGIES.filter((t) => t.category === cat)
      .map((t) => {
        const asset = t.logo ? `logo-${t.logo}` : t.icon;
        const s = supportOf(t);
        const levels = LEVELS.map((l) => `<span class="lv ${s[l.id] ? 'on' : ''}" title="${esc(l.help)}">${l.short}</span>`).join('');
        const lic = t.logo ? vendor.logos[t.logo].license?.type ?? 'not specified' : '—';
        return `<tr><td><img src="${uri(asset)}" width="28" height="28" alt=""></td><td><b>${esc(t.name)}</b><div class="what">${esc(t.what ?? '')}</div></td><td>${esc(t.kind)}</td><td>${t.logo ? 'official logo' : `TraceNaut icon (${esc(t.icon)})`}</td><td>${esc(lic)}</td><td class="lvs">${levels}</td></tr>`;
      })
      .join('');
    return `<h3>${esc(title)}</h3><table><thead><tr><th></th><th>Technology</th><th>Kind</th><th>Asset</th><th>Logo license</th><th>Support</th></tr></thead><tbody>${rows}</tbody></table>`;
  })
  .join('');

const attribution = Object.entries(vendor.logos)
  .map(([slug, v]) => `<li><b>${esc(v.title)}</b> — <a href="${esc(v.source)}">source</a>${v.license ? `, license: ${v.license.url ? `<a href="${esc(v.license.url)}">${esc(v.license.type)}</a>` : esc(v.license.type)}` : ', license not specified by the source'}${v.guidelines ? `, <a href="${esc(v.guidelines)}">brand guidelines</a>` : ''}</li>`)
  .join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TraceNaut asset gallery</title>
<style>
:root{--bg:#f6f7fa;--card:#fff;--text:#1a1e27;--muted:#646d80;--line:#e3e6ec}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1116;--card:#171a21;--text:#e4e7ee;--muted:#8e96a8;--line:#272c37}}
:root[data-theme=dark]{--bg:#0f1116;--card:#171a21;--text:#e4e7ee;--muted:#8e96a8;--line:#272c37}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,Inter,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}h2{margin:40px 0 12px;font-size:19px}h3{margin:28px 0 8px;font-size:15px}
.lead{color:var(--muted);max-width:760px}
.toggle{position:fixed;top:14px;right:16px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
figure{margin:0;padding:12px;border-radius:12px;background:var(--card);border:1px solid var(--line);display:grid;grid-template-columns:auto auto;align-items:end;gap:6px 10px}
figcaption{grid-column:1/-1;display:flex;flex-direction:column;font-size:12px}figcaption span{color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:7px 10px;border-top:1px solid var(--line);text-align:left;vertical-align:middle;font-size:12.5px}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-top:0}
.what{color:var(--muted);font-size:12px;max-width:420px}
.lv{display:inline-block;margin:1px;padding:1px 6px;border-radius:999px;font-size:10.5px;font-weight:600;color:var(--muted);border:1px solid var(--line);opacity:.45}
.lv.on{opacity:1;color:#138a5c;border-color:#138a5c55;background:#138a5c14}
.brand{display:flex;gap:16px;flex-wrap:wrap;align-items:center}.brand>div{padding:16px;border-radius:14px;border:1px solid var(--line)}
.on-dark{background:#111318}.on-light{background:#fff}
.legal{color:var(--muted);font-size:12.5px}.legal li{margin:2px 0}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px}
</style></head><body><button class="toggle" onclick="const r=document.documentElement;r.dataset.theme=r.dataset.theme==='dark'?'light':'dark'">Light / dark</button><main>
<h1>TraceNaut asset gallery</h1>
<p class="lead">${Object.keys(CONCEPT_ICONS).length} TraceNaut conceptual icons and ${Object.keys(vendor.logos).length} official technology logo tiles covering ${TECHNOLOGIES.length} technologies. Generated by <code>npm run assets</code> from <code>packages/assets/src/registry.mjs</code>. An icon means TraceNaut can <em>show</em> a technology; the support column says what TraceNaut can actually <em>do</em> with it.</p>
${brand.length ? `<h2>Brand</h2><div class="brand"><div class="on-light">${brand.map((b) => `<img src="${uri(b)}" height="64" alt="${esc(b)}">`).join(' ')}</div><div class="on-dark">${brand.map((b) => `<img src="${uri(b)}" height="64" alt="${esc(b)}">`).join(' ')}</div></div>` : ''}
<h2>Conceptual icons</h2><div class="grid">${conceptCards}</div>
<h2>Technologies</h2><p class="lead">Support levels: ${LEVELS.map((l) => `<b>${l.short}</b> ${esc(l.help)}`).join(' · ')}</p>${techSections}
<h2>Logo attribution</h2><p class="legal">Official logos come from <a href="https://simpleicons.org">Simple Icons</a> ${esc(vendor.version)} (collection CC0-1.0). Each logo is a trademark of its owner, shown only to identify the technology; its use does not imply endorsement. Logos are not reshaped or restyled: they appear in the brand colour or plain monochrome on a TraceNaut tile. Logos under non-commercial licenses are excluded. Where no official logo is available or usable (for example Java, C#, AWS, Azure, Vue, Sass, Heroku), TraceNaut uses its own conceptual icon instead of an imitation.</p><ul class="legal">${attribution}</ul>
</main></body></html>`;
writeFileSync(`${dist}gallery.html`, html);
console.log(`gallery: ${dist}gallery.html`);
