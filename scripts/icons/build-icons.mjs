// TraceNaut icon system: generates a family of 2.5D isometric SVG icons from shared
// primitives, so geometry, lighting and colour rules are identical across every icon.
//
//   node scripts/icons/build-icons.mjs        → packages/client/src/icons/*.svg + icons.ts
//
// Rules (see docs/DESIGN.md):
//   projection   true isometric: screen x = (x − y)·cos30°, screen y = (x + y)·sin30° − z
//   light        from the top-left: top faces lightest, left (y-facing) faces mid, right (x-facing) darkest
//   depth        soft vertical gradients per face, a light rim on top edges, one radial contact shadow
//   palette      one hue per meaning; faces derive from the hue by mixing with white/black
//   canvas       32×32, transparent, no filters, no text, centred on its footprint
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { COS, SIN, HUES, P, Icon, hex, line, shade, tint, ink, W } from './iso.mjs';
import { markSvg, BRAND } from './brand.mjs';
import { TECHNOLOGIES, CONCEPT_ICONS, CATEGORIES } from '../../packages/assets/src/registry.mjs';

const OUT = new URL('../../packages/assets/dist/icons/', import.meta.url).pathname;

// ------------------------------------------------------------------ the family
const icons = {};
const def = (name, draw) => {
  const icon = new Icon(name);
  draw(icon);
  icons[name] = icon.render();
};

/** Upright window (browser, page update): thin standing slab, screen on its front-left face. */
function windowSlab(i, hue, screen) {
  const f = i.box(-7, -1, 0, 14, 2.2, 10.5, hue);
  f.left(`<rect x=".8" y=".8" width="12.4" height="2.1" rx=".6" ${ink(hue, 0.55)}/><circle cx="2" cy="1.85" r=".45" fill="#fb7185"/><circle cx="3.3" cy="1.85" r=".45" fill="#fbbf24"/><circle cx="4.6" cy="1.85" r=".45" fill="#34d399"/><rect x=".8" y="3.4" width="12.4" height="6.4" rx=".6" fill="#fff" fill-opacity=".9"/>${screen}`);
  return f;
}

def('browser', (i) => {
  windowSlab(i, HUES.browser, `<rect x="2" y="4.6" width="5.2" height="1" rx=".5" fill="${HUES.browser}"/><rect x="2" y="6.3" width="9.6" height=".8" rx=".4" fill="${tint(HUES.browser, 0.45)}"/><rect x="2" y="7.8" width="7" height=".8" rx=".4" fill="${tint(HUES.browser, 0.45)}"/>`);
});

def('update', (i) => {
  windowSlab(i, HUES.browser, `<rect x="2" y="4.6" width="9.6" height="1" rx=".5" fill="${tint(HUES.browser, 0.45)}"/><rect x="2" y="6.4" width="6" height="1" rx=".5" fill="${tint(HUES.browser, 0.45)}"/>`);
  // a large refresh ring in front of the window: the page is redrawn
  const [cx, cy] = P(4, 4, 3);
  i.raw(`<g transform="translate(${cx} ${cy})"><circle r="5.6" fill="${HUES.ok}" stroke="${shade(HUES.ok, 0.6)}" stroke-width=".5"/>${line('M2.9-1.2A3.2 3.2 0 1 0 3 1.6', '#fff', 1.5)}<path d="M3.9-3.4 3.4.1 0-1.2z" fill="#fff"/></g>`, [[cx - 6, cy - 6], [cx + 6, cy + 6]]);
});

def('component', (i) => {
  // stacked interface cards
  i.box(-6, -5, 0, 12, 10, 1.2, shade(HUES.browser, 0.15), { light: 0 });
  i.box(-5.2, -4.2, 2.2, 10.4, 8.4, 1.2, HUES.browser, { noShadow: true });
  const t = i.box(-4.4, -3.4, 4.4, 8.8, 6.8, 1.2, tint(HUES.browser, 0.2), { noShadow: true });
  t.top(`<rect x="1.2" y="1.2" width="6.4" height="1.4" rx=".7" ${W(0.9)}/><rect x="1.2" y="3.6" width="4" height="1.6" rx=".8" fill="${HUES.browser}"/>`);
});

def('interaction', (i) => {
  const b = i.box(-6.5, -4, 0, 13, 8, 2.2, HUES.browser);
  b.top(`<rect x="2.5" y="2.5" width="8" height="3" rx="1.5" ${W(0.55)}/>`);
  // pointer, drawn upright in screen space above the button
  const [cx, cy] = P(1.5, 0.5, 2.2);
  i.raw(`<g transform="translate(${cx - 1} ${cy - 9.2})"><path d="M0 0v9.4l2.6-2.4 1.8 4 1.7-.8-1.8-3.9 3.6-.2z" fill="#fff" stroke="${shade(HUES.browser, 0.6)}" stroke-width=".9" stroke-linejoin="round"/></g>`, [[cx - 1.5, cy - 10], [cx + 8, cy + 3]]);
});

function codeCube(i, hue, cue) {
  const c = i.box(-5, -5, 0, 10, 10, 8.5, hue);
  c.left(line('M3.6 3.4 1.6 5.2l2 1.8M6.4 3.4l2 1.8-2 1.8', '#fff', 1.3, 0.95) + (cue === 'browser' ? `<rect x=".7" y=".6" width="8.6" height="1.5" rx=".5" fill="#fff" fill-opacity=".85"/><circle cx="1.6" cy="1.35" r=".4" fill="#fb7185"/><circle cx="2.7" cy="1.35" r=".4" fill="#fbbf24"/>` : ''));
  c.right(cue === 'server'
    ? `<rect x="1.2" y="1.3" width="7.6" height="1.4" rx=".5" fill="#fff" fill-opacity=".55"/><rect x="1.2" y="3.8" width="7.6" height="1.4" rx=".5" fill="#fff" fill-opacity=".55"/><rect x="1.2" y="6.3" width="7.6" height="1.4" rx=".5" fill="#fff" fill-opacity=".55"/>`
    : line('M2 3.2h5.2M2 5.2h3.4', '#fff', 1, 0.6));
  c.top(`<rect x="2" y="2" width="6" height="6" rx="1.4" fill="#fff" fill-opacity=".18"/>`);
}
def('code', (i) => codeCube(i, HUES.code));
def('code-browser', (i) => codeCube(i, HUES.browser, 'browser'));
def('code-server', (i) => codeCube(i, HUES.server, 'server'));

def('server', (i) => {
  for (let k = 0; k < 3; k++) {
    const u = i.box(-5, -4.5, k * 3.9, 10, 9, 3.2, HUES.server, { noShadow: k > 0 });
    u.left(`<rect x="1" y="1" width="5" height="1.1" rx=".55" ${ink(HUES.server, 0.45)}/><circle cx="8.2" cy="1.55" r=".55" fill="#bbf7d0"/>`);
  }
});

def('database', (i) => {
  const c = i.cylinder(0, 0, 0, 5.4, 10, HUES.database, [3.4, 6.8]);
  void c;
});

function packet(i, hue) {
  const p = i.box(-3.6, -3.6, 2.4, 7.2, 7.2, 4.6, hue);
  p.top(line('M.8.8 3.6 3.6 6.4.8', '#fff', 0.9, 0.85));
  p.left(`<rect x="1.4" y="1.4" width="4.4" height=".9" rx=".45" fill="#fff" fill-opacity=".55"/>`);
  return p;
}
// Arrows are drawn upright in screen space (not on the ground) so direction reads at 20 px:
// a request leaves to the right, a response comes back to the left.
const bigArrow = (dir, color) =>
  `<path d="${dir > 0 ? 'M0 -2.2h6.2v-3.2l6 5.4-6 5.4v-3.2H0z' : 'M0 -2.2h-6.2v-3.2l-6 5.4 6 5.4v-3.2H0z'}" fill="${color}" stroke="${shade(color, 0.55)}" stroke-width=".6" stroke-linejoin="round"/>`;
def('request', (i) => {
  packet(i, HUES.network);
  const [x, y] = P(3.6, 0, 3.4);
  i.raw(`<g transform="translate(${x + 0.5} ${y + 1})">${bigArrow(1, HUES.network)}</g>`, [[x, y - 5.6], [x + 13, y + 6.6]]);
});
def('response', (i) => {
  packet(i, tint(HUES.network, 0.12));
  const [x, y] = P(-3.6, 0, 3.4);
  i.raw(`<g transform="translate(${x - 0.5} ${y + 1})">${bigArrow(-1, HUES.ok)}</g>`, [[x - 13, y - 5.6], [x, y + 6.6]]);
});

def('network', (i) => {
  // two endpoints joined by a beam: communication between places
  i.box(-9, -2.5, 0, 5, 5, 5, HUES.browser);
  i.box(4, -2.5, 0, 5, 5, 5, HUES.server, { noShadow: true });
  const [ax, ay] = P(-4, 0, 3.2);
  const [bx, by] = P(4, 0, 3.2);
  const dot = (t) => `<circle cx="${ax + (bx - ax) * t}" cy="${ay + (by - ay) * t}" r="1.15" fill="#fff" stroke="${HUES.network}" stroke-width=".6"/>`;
  i.raw(line(`M${ax} ${ay}L${bx} ${by}`, tint(HUES.network, 0.2), 1.8) + dot(0.3) + dot(0.68));
  i.shadow(-9, -2.5, 18, 5);
});

def('branch', (i) => {
  const t = i.box(-7, -7, 0, 14, 14, 1.2, HUES.unknown);
  t.top(line('M2 7h4.2c1.6 0 2-2.6 3.6-3.4L12 2.8M6.2 7c1.6 0 2 2.6 3.6 3.4l2.2.8', '#fff', 1.2, 0.95) + `<circle cx="2" cy="7" r="1.1" fill="${HUES.network}"/><circle cx="12" cy="2.8" r="1.1" fill="${HUES.ok}"/><circle cx="12" cy="11.2" r="1.1" fill="${HUES.fail}"/>`);
});

function coin(i, hue, glyph) {
  i.cylinder(0, 0, 0, 7, 4, hue).lid(glyph);
}
// glyphs centred on (0, 0), drawn upright
def('ok', (i) => coin(i, HUES.ok, line('M-3.2 .2-.9 2.6 3.4-2.6', '#fff', 1.9)));
def('fail', (i) => coin(i, HUES.fail, line('M-2.5-2.5 2.5 2.5M2.5-2.5-2.5 2.5', '#fff', 1.9)));
def('likely', (i) => coin(i, HUES.likely, `<circle r="3.2" fill="none" stroke="#fff" stroke-width="1.7" stroke-dasharray="2 1.5"/>`));
def('unknown', (i) => coin(i, HUES.unknown, line('M-1.6-1.6a1.8 1.8 0 1 1 2.6 1.6c-.7.4-1 .7-1 1.4', '#fff', 1.6) + `<circle cx="0" cy="3.4" r=".95" fill="#fff"/>`));
def('static', (i) => coin(i, HUES.framework, `<circle r="3.1" fill="none" stroke="#fff" stroke-width="1.8"/>`));

// ---- technology kinds
def('language', (i) => {
  const d = i.box(-5, -1, 0, 10, 1.8, 12, HUES.language);
  d.left(line('M2.8 3.4 1.4 5l1.4 1.6M5.6 3.4 7 5 5.6 6.6M4.8 2.8 3.6 7.2', '#fff', 0.95, 0.95) + `<rect x="1.4" y="8.4" width="6.4" height=".8" rx=".4" fill="#fff" fill-opacity=".6"/><rect x="1.4" y="10" width="4.4" height=".8" rx=".4" fill="#fff" fill-opacity=".45"/>`);
});
def('library', (i) => {
  i.box(-5.5, -4, 0, 11, 8, 2.6, shade(HUES.library, 0.12));
  i.box(-4.5, -3.5, 2.6, 9, 7, 2.6, HUES.library, { noShadow: true });
  const top = i.box(-5, -3, 5.2, 10, 6, 2.6, tint(HUES.library, 0.15), { noShadow: true });
  top.left(`<rect x="1" y=".9" width="8" height=".8" rx=".4" fill="#fff" fill-opacity=".6"/>`);
});
def('framework', (i) => {
  // a structure that hosts the app's code: a frame around a code block
  const e = (a, b) => {
    const [x1, y1] = P(...a);
    const [x2, y2] = P(...b);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const r = 6.5;
  const H = 10;
  const back = [e([-r, -r, 0], [-r, -r, H]), e([-r, -r, H], [r, -r, H]), e([-r, -r, H], [-r, r, H])].join('');
  const front = [e([r, -r, 0], [r, -r, H]), e([-r, r, 0], [-r, r, H]), e([r, r, 0], [r, r, H]), e([r, -r, H], [r, r, H]), e([-r, r, H], [r, r, H]), e([r, -r, 0], [r, r, 0]), e([-r, r, 0], [r, r, 0])].join('');
  i.raw(line(back, shade(HUES.framework, 0.15), 1.1, 0.7), [P(-r, -r, H), P(r, r, 0), P(r, -r, H), P(-r, r, H)]);
  i.box(-3.5, -3.5, 0, 7, 7, 6.5, HUES.code).left(line('M2.4 2 1.1 3.2l1.3 1.2M4.6 2l1.3 1.2-1.3 1.2', '#fff', 0.9, 0.95));
  i.raw(line(front, HUES.framework, 1.1) + line(front, '#fff', 0.4, 0.45));
  i.shadow(-r, -r, 2 * r, 2 * r);
});
def('runtime', (i) => {
  const chip = i.box(-6, -6, 1, 12, 12, 2.4, HUES.runtime);
  chip.top(`<rect x="3" y="3" width="6" height="6" rx="1.2" fill="${shade(HUES.runtime, 0.45)}"/><path d="M4.6 6.2l1.2 1.2 2.4-2.6" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>`);
  chip.left(`<rect x="1.5" y=".7" width="1" height="1.2" fill="#fff" fill-opacity=".7"/><rect x="4.5" y=".7" width="1" height="1.2" fill="#fff" fill-opacity=".7"/><rect x="7.5" y=".7" width="1" height="1.2" fill="#fff" fill-opacity=".7"/><rect x="10.5" y=".7" width="1" height="1.2" fill="#fff" fill-opacity=".7"/>`);
});
def('protocol', (i) => {
  i.box(-8, -2, 0, 3, 4, 9, HUES.browser);
  i.box(5, -2, 0, 3, 4, 9, HUES.server, { noShadow: true });
  const [ax, ay] = P(-5, 0, 7);
  const [bx, by] = P(5, 0, 7);
  const [cx, cy] = P(-5, 0, 3.5);
  const [dx, dy] = P(5, 0, 3.5);
  const head = (x, y, ang, color) => `<path transform="translate(${x} ${y}) rotate(${ang})" d="M0 0l-3 -1.8v3.6z" fill="${color}"/>`;
  const ang = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
  i.raw(line(`M${ax} ${ay}L${bx - 1.8} ${by - 1}`, HUES.network, 1.5) + head(bx, by, ang, HUES.network) + line(`M${dx} ${dy}L${cx + 1.8} ${cy + 1}`, HUES.ok, 1.5) + head(cx, cy, ang + 180, HUES.ok));
  i.shadow(-8, -2, 16, 4);
});
def('data', (i) => {
  const t = i.box(-6, -5, 0, 12, 10, 2, HUES.data);
  t.top(line('M3.2 2.2c-1 0-1.2.6-1.2 1.4v.8c0 .6-.5 1-1 1 .5 0 1 .4 1 1v.8c0 .8.2 1.4 1.2 1.4M8.8 2.2c1 0 1.2.6 1.2 1.4v.8c0 .6.5 1 1 1-.5 0-1 .4-1 1v.8c0 .8-.2 1.4-1.2 1.4', '#fff', 0.95));
});
def('api', (i) => {
  // a plug: a built-in capability the page's code plugs into
  i.box(-6, -6, 0, 12, 12, 1.6, shade(HUES.api, 0.25));
  const body = i.box(-3.5, -3.5, 1.6, 7, 7, 6, HUES.api, { noShadow: true });
  body.left(`<rect x="1.6" y="2" width="3.8" height="1" rx=".5" fill="#fff" fill-opacity=".6"/>`);
  i.box(-2.2, -1.4, 7.6, 1.1, 1.1, 3.4, tint(HUES.api, 0.5), { noShadow: true });
  i.box(1.1, -1.4, 7.6, 1.1, 1.1, 3.4, tint(HUES.api, 0.5), { noShadow: true });
});

// ---- additional hues for the expanded family
const H2 = { sky: '#60a5fa', gold: '#facc15', slate: '#94a3b8', brown: '#c08457', rose: '#fb7185', mint: '#34d399' };

// symbol paths for dimensional badges (drawn in small boxes)
const SYM = {
  cloud: 'M3.6 10.5h7.6a2.7 2.7 0 0 0 .4-5.4 3.8 3.8 0 0 0-7.2-1.2A3.1 3.1 0 0 0 3.6 10.5z',
  bolt: 'M6.6 0 1 7.2h4.2L4.2 12.4 10.2 4.8H6z',
  shield: 'M6 0 11.2 2v4.2c0 3.2-2.3 5.6-5.2 6.6C3.1 11.8.8 9.4.8 6.2V2z',
  lock: 'M2 5.4h8.4v6.6H2z',
  key: 'M3.6 1.4a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4zM6.6 4h6v1.6h-1.2v1.8H10V5.6H6.6z',
  hourglass: 'M1.6 0h8.8v1.4L7 6l3.4 4.6V12H1.6v-1.4L5 6 1.6 1.4z',
  warning: 'M6.4 0 12.8 11.4H0z',
  card: 'M1 0h11a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V1a1 1 0 0 1 1-1z',
  clipboard: 'M1 1.4h9.6v11H1z',
  doc: 'M0 0h7l3 3v10H0z',
  signL: 'M2 0h8v3.4H2L0 1.7z',
  signR: 'M0 0h8l2 1.7-2 1.7H0z',
  ring: 'M6 0a6 6 0 1 1 0 12A6 6 0 0 1 6 0zm0 2.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z',
};

def('cloud', (i) => {
  i.box(-7, -5, 0, 14, 10, 1.4, H2.slate);
  const [x, y] = P(0, 0, 1.4);
  i.badge(SYM.cloud, H2.sky, x - 9, y - 13, 1.35, 13, 11);
});
def('gateway', (i) => {
  i.box(-8, -4, 0, 16, 8, 1.2, H2.slate);
  i.box(-7, -1.5, 1.2, 3, 3, 9, HUES.network, { noShadow: true });
  i.box(4, -1.5, 1.2, 3, 3, 9, HUES.network, { noShadow: true });
  i.box(-7.5, -2, 10.2, 15, 4, 2, tint(HUES.network, 0.15), { noShadow: true });
  i.ground(`<path d="M-3 -0.9h3.6v-1.5l3 2.4-3 2.4v-1.5H-3z" fill="${HUES.ok}"/>`, [[-3, -2.4], [3.6, 2.4]]);
});
def('microservices', (i) => {
  i.box(-8, -8, 0, 16, 16, 1, H2.slate);
  const c = [[-6, -6], [1.5, -5], [-4, 2]];
  const [[ax, ay], [bx, by], [cx2, cy2]] = c.map(([x, y]) => P(x + 2.2, y + 2.2, 4.4));
  i.raw(line(`M${ax} ${ay}L${bx} ${by}M${ax} ${ay}L${cx2} ${cy2}M${bx} ${by}L${cx2} ${cy2}`, HUES.network, 0.9, 0.9));
  for (const [x, y] of c) i.box(x, y, 1, 4.4, 4.4, 4.2, HUES.server, { noShadow: true });
});
def('event-bus', (i) => {
  i.box(-9, -2, 0, 18, 4, 1.6, HUES.network);
  for (const x of [-7.5, -1.5, 4.5]) i.box(x, -1.5, 1.6, 3, 3, 3.2, HUES.server, { noShadow: true });
  const [x, y] = P(-1, -1, 7);
  i.badge(SYM.bolt, H2.gold, x - 3, y - 9, 0.95, 10.2, 12.4);
});
def('storage', (i) => {
  const b = i.box(-6, -5, 0, 12, 10, 6.5, H2.brown);
  i.box(-6.6, -5.6, 6.5, 13.2, 11.2, 1.4, tint(H2.brown, 0.15), { noShadow: true });
  b.left(`<rect x="4.6" y="2" width="3" height="1.3" rx=".6" fill="#fff" fill-opacity=".7"/>`);
});
def('container', (i) => {
  const c = i.box(-9, -3.5, 0, 18, 7, 7, H2.sky);
  c.left(line('M2 1v5M4.5 1v5M7 1v5M9.5 1v5M12 1v5M14.5 1v5M17 1v5', '#fff', 0.7, 0.5));
  c.right(line('M1.5 1v5M3.5 1v5M5.5 1v5', '#fff', 0.7, 0.45));
});
def('queue', (i) => {
  i.box(-9, -3, 0, 18, 6, 1.2, H2.slate);
  [-7.5, -3, 1.5, 6].forEach((x, k) => {
    const p = i.box(x, -2, 1.2, 3.4, 4, 3.2 - k * 0.4, k === 0 ? HUES.ok : HUES.network, { noShadow: true });
    p.top(line('M.4.4 1.7 2 3 .4', '#fff', 0.6, 0.85));
  });
});
def('cache', (i) => {
  i.cylinder(0, 0, 0, 5, 7.5, HUES.database, [3.7]);
  const [x, y] = P(1, 1, 7.5);
  i.badge(SYM.bolt, H2.gold, x + 0.5, y - 11, 0.9, 10.2, 12.4);
});
def('hook', (i) => {
  const c = i.box(-5, -5, 0, 10, 10, 8.5, HUES.code);
  c.left(line('M6.5 1.8v3.6a2.2 2.2 0 0 1-4.4 0v-.8', '#fff', 1.3, 0.95) + `<circle cx="6.5" cy="1.6" r=".9" fill="#fff"/>`);
});
def('class', (i) => {
  const e = (a, b) => {
    const [x1, y1] = P(...a);
    const [x2, y2] = P(...b);
    return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
  };
  const r = 6;
  const H = 11;
  const edges = [e([-r, -r, H], [r, -r, H]), e([r, -r, H], [r, r, H]), e([r, r, H], [-r, r, H]), e([-r, r, H], [-r, -r, H]), e([r, -r, 0], [r, -r, H]), e([-r, r, 0], [-r, r, H]), e([r, r, 0], [r, r, H]), e([r, -r, 0], [r, r, 0]), e([-r, r, 0], [r, r, 0])].join('');
  i.raw(`<path d="${edges}" fill="none" stroke="${HUES.code}" stroke-width="1.1" stroke-dasharray="1.6 1.1" stroke-linecap="round"/>`, [P(-r, -r, H), P(r, r, 0), P(r, -r, H), P(-r, r, H)]);
  i.box(-2.5, -2.5, 0, 5, 5, 5, HUES.code);
  i.shadow(-r, -r, 2 * r, 2 * r);
});
def('object', (i) => {
  const c = i.box(-5, -5, 0, 10, 10, 8.5, tint(HUES.code, 0.1));
  c.left(`<rect x="1.2" y="1.6" width="3" height="1.2" rx=".6" fill="#fff" fill-opacity=".9"/><rect x="5" y="1.6" width="3.8" height="1.2" rx=".6" fill="#fff" fill-opacity=".5"/><rect x="1.2" y="4" width="3" height="1.2" rx=".6" fill="#fff" fill-opacity=".9"/><rect x="5" y="4" width="2.6" height="1.2" rx=".6" fill="#fff" fill-opacity=".5"/><rect x="1.2" y="6.4" width="3" height="1.2" rx=".6" fill="#fff" fill-opacity=".9"/><rect x="5" y="6.4" width="3.4" height="1.2" rx=".6" fill="#fff" fill-opacity=".5"/>`);
});
def('state', (i) => {
  const c = i.box(-7, -7, 0, 14, 14, 2.2, HUES.browser);
  let cells = '';
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) cells += `<rect x="${2 + k * 3.6}" y="${2 + r * 3.6}" width="2.6" height="2.6" rx=".6" fill="#fff" fill-opacity="${(r + k) % 2 ? 0.95 : 0.45}"/>`;
  c.top(cells);
});
def('event', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.6, H2.slate);
  const [x, y] = P(0, 0, 2.6);
  i.badge(SYM.bolt, H2.gold, x - 5, y - 14, 1.05, 10.2, 12.4);
});
def('route', (i) => {
  i.box(-6, -4, 0, 12, 8, 1.2, H2.slate);
  i.box(-0.7, -0.7, 1.2, 1.4, 1.4, 12, shade(H2.brown, 0.1), { noShadow: true });
  const [x, y] = P(0, 0, 13.2);
  i.badge(SYM.signR, HUES.ok, x + 0.4, y - 0.6, 0.85, 10, 3.4, { depth: 1 });
  i.badge(SYM.signL, HUES.network, x - 8.6, y + 3.4, 0.85, 10, 3.4, { depth: 1 });
});
def('middleware', (i) => {
  i.box(-8, -3, 0, 16, 6, 1.2, H2.slate);
  i.box(-7, -1.2, 1.2, 2.4, 2.4, 7, HUES.server, { noShadow: true });
  i.box(4.6, -1.2, 1.2, 2.4, 2.4, 7, HUES.server, { noShadow: true });
  const bar = i.box(-6, -0.6, 5.2, 11.6, 1.2, 1.6, H2.gold, { noShadow: true });
  bar.left(line('M1.5 .2l1.2 1.2M4.5 .2l1.2 1.2M7.5 .2l1.2 1.2', shade(H2.gold, 0.6), 0.7, 0.8));
});
def('async', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.4, H2.slate);
  const [x, y] = P(0, 0, 2.4);
  i.badge(SYM.hourglass, HUES.network, x - 5.2, y - 14.2, 1.05, 12, 12, { inner: `<path d="M3.4 10.2h5.2L6 7.6z" fill="${H2.gold}"/><path d="M3.6 2.2h4.8L6 4.6z" fill="${H2.gold}" fill-opacity=".6"/>` });
});
def('loop', (i) => {
  i.box(-7, -5, 0, 14, 10, 1.4, H2.slate);
  const [x, y] = P(0, 0, 1.4);
  i.raw(`<g transform="translate(${x} ${y - 7.4})">${line('M4.8 -1.6A5 5 0 1 1 -2.2 -4.6', HUES.network, 2.4)}<path d="M-4.2 -7.4 -1 -4.2 -4.6 -2.4z" fill="${HUES.network}"/></g>`, [[x - 6, y - 14], [x + 6, y - 1]]);
});
def('condition', (i) => {
  // the flowchart decision diamond, standing on the shared disc
  i.cylinder(0, 0, 0, 6.2, 2.4, H2.slate);
  const [x, y] = P(0, 0, 2.4);
  i.badge('M6.4 0 12.8 6.4 6.4 12.8 0 6.4z', H2.gold, x - 6.8, y - 15.4, 1.05, 12.8, 12.8, {
    inner: `<path d="M4.8 4.6a1.7 1.7 0 1 1 2.5 1.5c-.6.3-.9.7-.9 1.3" fill="none" stroke="${shade(H2.gold, 0.62)}" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.4" cy="9.4" r=".8" fill="${shade(H2.gold, 0.62)}"/>`,
  });
});
def('error', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.2, H2.slate);
  const [x, y] = P(0, 0, 2.2);
  i.badge(SYM.warning, HUES.fail, x - 6.6, y - 13.6, 1.03, 12.8, 11.4, { inner: `<path d="M6.4 3.8v3.6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="6.4" cy="9.2" r=".85" fill="#fff"/>` });
});
def('transform', (i) => {
  i.ground(`<path d="M-13 -1h4.6v-1.6l3 2.6-3 2.6V1H-13z" fill="${HUES.network}"/><path d="M6 -1h4.6v-1.6l3 2.6-3 2.6V1H6z" fill="${HUES.ok}"/>`, [[-13, -2.6], [13.6, 2.6]]);
  i.extrude([[-4, -4], [4.5, 0], [-4, 4]], 0, 7, HUES.code);
});
def('query', (i) => {
  i.cylinder(-1, 1, 0, 5, 8.5, HUES.database, [4.2]);
  const [x, y] = P(3, -3, 8);
  i.badge(SYM.ring, HUES.network, x - 2, y - 8, 0.8, 12, 12, { depth: 1 });
  i.raw(line(`M${x + 5.6} ${y + 1.4}l3.2 3.2`, shade(HUES.network, 0.3), 2.2));
});
def('transaction', (i) => {
  i.cylinder(0, 0, 0, 5.2, 9, HUES.database, [4.5]);
  const [x, y] = P(2.5, 2.5, 4);
  i.badge(SYM.shield, HUES.ok, x - 1, y - 7, 0.78, 11.2, 12.8, { inner: line('M3.4 6.4 5.4 8.4 8.8 4.4', '#fff', 1.6) });
});
def('auth', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.4, H2.slate);
  const [x, y] = P(0, 0, 2.4);
  i.badge(SYM.shield, HUES.ok, x - 6, y - 15, 1.08, 11.2, 12.8, { inner: line('M3.6 6.4 5.4 8.2 8.6 4.6', '#fff', 1.5) });
});
def('lock', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.4, H2.slate);
  const [x, y] = P(0, 0, 2.4);
  i.raw(`<path d="M${x - 3} ${y - 9}v-2.4a3 3 0 0 1 6 0V${y - 9}" fill="none" stroke="${shade(H2.gold, 0.25)}" stroke-width="1.8"/>`, [[x - 4, y - 15], [x + 4, y - 8]]);
  i.badge(SYM.lock, H2.gold, x - 5.2, y - 15.6, 1.05, 10.4, 12, { inner: `<circle cx="6.2" cy="8.2" r="1.1" fill="${shade(H2.gold, 0.6)}"/><path d="M6.2 8.6v1.6" stroke="${shade(H2.gold, 0.6)}" stroke-width="1"/>` });
});
def('session', (i) => {
  i.cylinder(0, 0, 0, 6.6, 2.2, H2.slate);
  const [x, y] = P(0, 0, 2.2);
  i.badge(SYM.card, HUES.browser, x - 7, y - 11.6, 1.05, 13, 9.4, { inner: `<circle cx="3.6" cy="4.2" r="1.8" fill="#fff" fill-opacity=".9"/><rect x="6.6" y="2.8" width="4.6" height="1" rx=".5" fill="#fff" fill-opacity=".9"/><rect x="6.6" y="4.8" width="3.4" height="1" rx=".5" fill="#fff" fill-opacity=".55"/>` });
});
def('token', (i) => {
  i.cylinder(0, 0, 0, 6.2, 2.4, H2.slate);
  const [x, y] = P(0, 0, 2.4);
  i.badge(SYM.key, H2.gold, x - 6.4, y - 11.6, 1.02, 12.6, 9.2);
});
def('user', (i) => {
  i.cylinder(0, 0, 0, 4.6, 5.5, HUES.browser);
  i.sphere(0, 0, 6.2, 3.6, tint(HUES.browser, 0.2));
});
def('tool', (i) => {
  const b = i.box(-7, -4, 0, 14, 8, 5.5, HUES.fail);
  b.left(`<rect x="5.6" y="1.4" width="3" height="1.4" rx=".5" fill="#fff" fill-opacity=".8"/>`);
  i.box(-3.5, -0.6, 5.5, 1.2, 1.2, 2.6, H2.slate, { noShadow: true });
  i.box(2.3, -0.6, 5.5, 1.2, 1.2, 2.6, H2.slate, { noShadow: true });
  i.box(-3.5, -0.6, 8.1, 7, 1.2, 1.2, H2.slate, { noShadow: true });
});
def('test', (i) => {
  i.cylinder(0, 0, 0, 6.6, 2.2, H2.slate);
  const [x, y] = P(0, 0, 2.2);
  i.badge(SYM.clipboard, H2.mint, x - 5.6, y - 15, 1.08, 9.6, 11, { inner: line('M2.6 4.2 3.6 5.2 5.4 3.2M2.6 8 3.6 9 5.4 7', '#fff', 1) + `<rect x="6.4" y="3.8" width="2.6" height=".9" rx=".45" fill="#fff"/><rect x="6.4" y="7.6" width="2.6" height=".9" rx=".45" fill="#fff"/><rect x="3.4" y=".4" width="4.8" height="2" rx=".7" fill="${shade(H2.mint, 0.4)}"/>` });
});
def('package', (i) => {
  const b = i.box(-6, -6, 0, 12, 12, 8, H2.brown);
  b.top(`<rect x="0" y="5" width="12" height="2" fill="${shade(H2.brown, 0.35)}" fill-opacity=".8"/>`);
  b.left(`<rect x="5" y="0" width="2" height="8" fill="${shade(H2.brown, 0.3)}" fill-opacity=".7"/>`);
});
def('file', (i) => {
  const d = i.box(-5, -1, 0, 10, 1.8, 12, H2.slate);
  d.left(`<rect x="1.4" y="1.8" width="5.6" height=".9" rx=".45" fill="#fff" fill-opacity=".85"/><rect x="1.4" y="3.8" width="7" height=".9" rx=".45" fill="#fff" fill-opacity=".6"/><rect x="1.4" y="5.8" width="6.2" height=".9" rx=".45" fill="#fff" fill-opacity=".6"/><rect x="1.4" y="7.8" width="4.4" height=".9" rx=".45" fill="#fff" fill-opacity=".6"/>`);
});
def('config', (i) => {
  const t = i.box(-7, -7, 0, 14, 14, 2.2, H2.slate);
  t.top(line('M2 3.5h10M2 7h10M2 10.5h10', '#fff', 0.9, 0.6) + `<circle cx="4.5" cy="3.5" r="1.3" fill="${HUES.network}"/><circle cx="9.2" cy="7" r="1.3" fill="${HUES.ok}"/><circle cx="6" cy="10.5" r="1.3" fill="${H2.gold}"/>`);
});

// ------------------------------------------------------------------ official logo tiles
// The logo itself is never reshaped or restyled: it sits flat, in its brand colour (or a
// plain monochrome when the brand colour would be illegible), on a dimensional tile.
const vendor = JSON.parse(readFileSync(new URL('../../packages/assets/vendor/simple-icons.json', import.meta.url), 'utf8'));
const lum = (h) => {
  const [r, g, b] = hex(`#${h}`).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
function logoTile(slug) {
  const v = vendor.logos[slug];
  const L = lum(v.hex);
  const dark = L > 0.55; // very light brand colours sit on a dark tile
  const tileLum = dark ? 0.03 : 0.93;
  const fill = contrast(L, tileLum) >= 1.6 ? `#${v.hex}` : dark ? '#ffffff' : '#16181d';
  const [f0, f1, side, stroke] = dark ? ['#363b4c', '#1f2330', '#11131a', '#0b0d12'] : ['#ffffff', '#eceef4', '#c9cdd8', '#aab0bf'];
  const id = `t-${slug}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="${id}-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f0}"/><stop offset="1" stop-color="${f1}"/></linearGradient><radialGradient id="${id}-s"><stop offset="0" stop-color="#05060d" stop-opacity=".34"/><stop offset="1" stop-color="#05060d" stop-opacity="0"/></radialGradient></defs><ellipse cx="17" cy="28.4" rx="12.5" ry="2.6" fill="url(#${id}-s)"/><rect x="5.6" y="5.2" width="23" height="23" rx="5.2" fill="${side}"/><rect x="4" y="3.4" width="23" height="23" rx="5.2" fill="url(#${id}-f)" stroke="${stroke}" stroke-opacity=".7" stroke-width=".5"/><path d="M5.2 22V9a4.2 4.2 0 0 1 4.2-4.2H22" fill="none" stroke="#fff" stroke-opacity="${dark ? 0.18 : 0.9}" stroke-width=".7" stroke-linecap="round"/><g transform="translate(7.3 6.7) scale(.6833)"><path d="${v.path}" fill="${fill}"/></g></svg>`;
}

// ------------------------------------------------------------------ write
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const files = {};
for (const [name, svg] of Object.entries(icons)) files[name] = svg;
// Official logo paths are inserted exactly as published: never rounded, reshaped or recoloured
// beyond the brand colour / plain monochrome.
for (const slug of Object.keys(vendor.logos)) files[`logo-${slug}`] = logoTile(slug);
for (const [name, svg] of Object.entries(files)) writeFileSync(`${OUT}${name}.svg`, `${svg}\n`);

// ---- brand: mark variants and wordmark lockups
const lockup = (theme) => {
  const mark = markSvg('color').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const [trace, naut] = theme === 'dark' ? ['#f1f2f8', '#a5a6ff'] : ['#14162b', '#4f46e5'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 236 64" width="236" height="64"><g>${mark}</g><text x="72" y="42" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="28" font-weight="650" letter-spacing="-0.4"><tspan fill="${trace}">Trace</tspan><tspan fill="${naut}">Naut</tspan></text></svg>`;
};
const brandFiles = {
  'brand-mark': markSvg('color'),
  'brand-favicon': markSvg('favicon'),
  'brand-mono-light': markSvg('mono-light'),
  'brand-mono-dark': markSvg('mono-dark'),
  'brand-lockup-light': lockup('light'),
  'brand-lockup-dark': lockup('dark'),
};
for (const [name, svg] of Object.entries(brandFiles)) {
  files[name] = svg;
  writeFileSync(`${OUT}${name}.svg`, `${svg}\n`);
}
void BRAND;

const missingConcepts = Object.keys(CONCEPT_ICONS).filter((c) => !icons[c]);
if (missingConcepts.length) throw new Error(`registry lists concept icons that are not drawn: ${missingConcepts.join(', ')}`);
for (const t of TECHNOLOGIES) {
  const asset = t.logo ? `logo-${t.logo}` : t.icon;
  if (!asset || !files[asset]) throw new Error(`${t.id} has no asset (${asset})`);
}

// Manifest for the client: display data only (detection signals stay in the daemon).
const version = createHash('sha256').update(Object.values(files).join('')).digest('hex').slice(0, 10);
const manifest = {
  version,
  categories: CATEGORIES,
  concepts: CONCEPT_ICONS,
  technologies: Object.fromEntries(
    TECHNOLOGIES.map((t) => [t.id, { name: t.name, category: t.category, kind: t.kind, asset: t.logo ? `logo-${t.logo}` : t.icon, logo: !!t.logo, what: t.what, effect: t.effect }]),
  ),
  logos: Object.fromEntries(Object.entries(vendor.logos).map(([slug, v]) => [slug, { title: v.title, license: v.license?.type ?? null, guidelines: v.guidelines }])),
};
writeFileSync(new URL('../../packages/assets/dist/manifest.json', import.meta.url), JSON.stringify(manifest));
const sizes = Object.values(files).map((f) => f.length);
console.log(`wrote ${Object.keys(icons).length} conceptual icons + ${Object.keys(vendor.logos).length} logo tiles (${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(0)} KB total, avg ${(sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024).toFixed(1)} KB) · version ${version}`);
