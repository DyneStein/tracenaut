// Shared isometric drawing library for TraceNaut's icons and brand marks.
// Projection: true isometric. Light: top-left. See docs/DESIGN.md.
export const COS = Math.cos(Math.PI / 6);
export const SIN = 0.5;

export const HUES = {
  browser: '#7c7cff',
  server: '#2ec4a0',
  database: '#f2a03d',
  network: '#38bdf8',
  code: '#a78bfa',
  ok: '#34d399',
  fail: '#fb7185',
  likely: '#fbbf24',
  unknown: '#94a3b8',
  language: '#c084fc',
  library: '#2dd4bf',
  framework: '#60a5fa',
  runtime: '#4ade80',
  data: '#fb923c',
  api: '#f472b6',
};

// ------------------------------------------------------------------ colour helpers
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const toHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (h, target, t) => toHex(hex(h).map((v, i) => v + (target[i] - v) * t));
export const tint = (h, t) => mix(h, [255, 255, 255], t);
export const shade = (h, t) => mix(h, [12, 14, 28], t);

/**
 * Round long decimals to 2 places. Path data may chain numbers without separators
 * (".5.25" is two numbers), so when a rounded value loses its decimal point and the
 * next character starts another number, a space is inserted to keep them apart.
 */
export function roundNumbers(svg) {
  return svg.replace(/-?\d*\.\d{3,}/g, (n, offset, all) => {
    const r = String(Number(Number(n).toFixed(2)));
    const next = all[offset + n.length];
    return !r.includes('.') && next === '.' ? `${r} ` : r;
  });
}

// ------------------------------------------------------------------ geometry
export const P = (x, y, z) => [(x - y) * COS, (x + y) * SIN - z];
export const pts = (list) => list.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

export class Icon {
  constructor(name) {
    this.name = name;
    this.defs = [];
    this.layers = [];
    this.points = [];
    this.gid = 0;
    this.shadowFoot = null;
  }
  id(kind) {
    return `${this.name}-${kind}${this.gid++}`;
  }
  grad(stops, vertical = true) {
    const id = this.id('g');
    const [x2, y2] = vertical ? [0, 1] : [1, 0];
    this.defs.push(`<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`).join('')}</linearGradient>`);
    return `url(#${id})`;
  }
  track(list) {
    this.points.push(...list);
    return list;
  }
  poly(list, fill, extra = '') {
    this.track(list);
    this.layers.push(`<polygon points="${pts(list)}" fill="${fill}"${extra}/>`);
  }
  path(d, attrs, bounds = []) {
    this.track(bounds);
    this.layers.push(`<path d="${d}" ${attrs}/>`);
  }
  raw(svg, bounds = []) {
    this.track(bounds);
    this.layers.push(svg);
  }
  /** Ground footprint for the contact shadow (in world units). */
  shadow(x0, y0, w, d) {
    this.shadowFoot = { x0, y0, w, d };
  }

  /** Axis-aligned box. Returns face planes for placing glyphs. */
  box(x0, y0, z0, w, d, h, hue, opts = {}) {
    const x1 = x0 + w;
    const y1 = y0 + d;
    const z1 = z0 + h;
    const top = [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)];
    const left = [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)];
    const right = [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)];
    const l = opts.light ?? 0;
    const edge = ` stroke="${shade(hue, 0.62)}" stroke-opacity=".5" stroke-width=".45" stroke-linejoin="round"`;
    this.poly(left, this.grad([[0, tint(hue, 0.05 + l)], [1, shade(hue, 0.18)]]), edge);
    this.poly(right, this.grad([[0, shade(hue, 0.22 - l)], [1, shade(hue, 0.48)]]), edge);
    this.poly(top, this.grad([[0, tint(hue, 0.55 + l)], [1, tint(hue, 0.22 + l)]]), edge);
    // rim light on the two top edges facing the light, and a crisp front edge
    this.raw(`<polyline points="${pts([top[3], top[0], top[1]])}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".6" stroke-linejoin="round"/>`);
    this.raw(`<polyline points="${pts([top[3], top[2], top[1]])}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width=".5" stroke-linejoin="round"/>`);
    if (!opts.noShadow) this.shadowFoot ??= { x0, y0, w, d };
    return {
      top: (svg) => this.raw(`<g transform="matrix(${COS} ${SIN} ${-COS} ${SIN} ${P(x0, y0, z1).join(' ')})">${svg}</g>`),
      left: (svg) => this.raw(`<g transform="matrix(${COS} ${SIN} 0 1 ${P(x0, y1, z1).join(' ')})">${svg}</g>`),
      right: (svg) => this.raw(`<g transform="matrix(${COS} ${-SIN} 0 1 ${P(x1, y1, z1).join(' ')})">${svg}</g>`),
      w,
      d,
      h,
    };
  }

  /** Vertical cylinder centred on (cx, cy). */
  cylinder(cx, cy, z0, r, h, hue, bands = []) {
    const rx = r * 1.2247;
    const ry = r * 0.7071;
    const [tx, ty] = P(cx, cy, z0 + h);
    const [, by] = P(cx, cy, z0);
    this.track([[tx - rx, ty - ry], [tx + rx, by + ry]]);
    const side = this.grad([[0, tint(hue, 0.18)], [0.45, hue], [1, shade(hue, 0.5)]], false);
    this.raw(`<path d="M${tx - rx} ${ty}V${by}A${rx} ${ry} 0 0 0 ${tx + rx} ${by}V${ty}A${rx} ${ry} 0 0 1 ${tx - rx} ${ty}Z" fill="${side}" stroke="${shade(hue, 0.62)}" stroke-opacity=".5" stroke-width=".45"/>`);
    for (const z of bands) {
      const [, y] = P(cx, cy, z0 + z);
      this.raw(`<path d="M${tx - rx} ${y}A${rx} ${ry} 0 0 0 ${tx + rx} ${y}" fill="none" stroke="${tint(hue, 0.6)}" stroke-opacity=".75" stroke-width=".7"/>`);
    }
    this.raw(`<ellipse cx="${tx}" cy="${ty}" rx="${rx}" ry="${ry}" fill="${this.grad([[0, tint(hue, 0.62)], [1, tint(hue, 0.25)]])}"/>`);
    this.raw(`<path d="M${tx - rx} ${ty}A${rx} ${ry} 0 0 1 ${tx + rx} ${ty}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".6"/>`);
    // specular highlight on the lid (from Codex's proposal)
    this.raw(`<ellipse cx="${tx - rx * 0.28}" cy="${ty - ry * 0.25}" rx="${rx * 0.38}" ry="${ry * 0.3}" fill="#fff" fill-opacity=".35"/>`);
    this.shadowFoot ??= { x0: cx - r, y0: cy - r, w: 2 * r, d: 2 * r };
    return {
      /** Glyph kept upright and squashed into the lid's perspective, so ✓ and × stay recognisable. */
      lid: (svg) => this.raw(`<g transform="translate(${tx} ${ty}) scale(1 .62)">${svg}</g>`),
    };
  }

  /** A flat shape lying on the ground plane (arrows, paths). Coordinates are world x/y. */
  ground(svg, bounds) {
    this.track(bounds.map(([x, y]) => P(x, y, 0)));
    this.raw(`<g transform="matrix(${COS} ${SIN} ${-COS} ${SIN} 0 0)">${svg}</g>`);
  }

  /** Extrude a convex footprint (world x/y points, counter-clockwise seen from above). */
  extrude(points, z0, h, hue, opts = {}) {
    // Normalise winding so outward normals are computed consistently.
    const area = points.reduce((sum, [x1, y1], k) => {
      const [x2, y2] = points[(k + 1) % points.length];
      return sum + (x1 * y2 - x2 * y1);
    }, 0);
    if (area < 0) points = [...points].reverse();
    const n = points.length;
    const edge = ` stroke="${shade(hue, 0.62)}" stroke-opacity=".5" stroke-width=".45" stroke-linejoin="round"`;
    for (let k = 0; k < n; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[(k + 1) % n];
      const nx = by - ay;
      const ny = -(bx - ax);
      if (nx + ny <= 0) continue; // faces turned away from the viewer
      const towardLeft = ny / (Math.abs(nx) + Math.abs(ny) || 1);
      const face = [P(ax, ay, z0), P(bx, by, z0), P(bx, by, z0 + h), P(ax, ay, z0 + h)];
      const fill = towardLeft > 0.3
        ? this.grad([[0, tint(hue, 0.05)], [1, shade(hue, 0.18)]])
        : this.grad([[0, shade(hue, 0.22)], [1, shade(hue, 0.48)]]);
      this.poly(face, fill, edge);
    }
    const top = points.map(([x, y]) => P(x, y, z0 + h));
    this.poly(top, this.grad([[0, tint(hue, 0.55)], [1, tint(hue, 0.22)]]), edge);
    this.raw(`<polygon points="${pts(top)}" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width=".5" stroke-linejoin="round"/>`);
    if (!opts.noShadow) {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      this.shadowFoot ??= { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
    }
    return { topAt: (x, y) => P(x, y, z0 + h) };
  }

  /**
   * An upright symbol with real thickness (shields, keys, lightning…): a few darker copies
   * stepped toward the bottom-right (away from the top-left light), then a lit front face.
   * `d` is drawn in a w×h box; (x, y) is its top-left in screen space; s scales it.
   */
  badge(d, hue, x, y, s, w, h, opts = {}) {
    const depth = opts.depth ?? 1.4;
    const steps = 4;
    let back = '';
    for (let k = steps; k >= 1; k--) {
      const o = (depth * k) / steps;
      back += `<path d="${d}" fill="${shade(hue, 0.35 + 0.05 * k)}" transform="translate(${o.toFixed(2)} ${(o * 0.75).toFixed(2)})"/>`;
    }
    const face = this.grad([[0, tint(hue, 0.35)], [1, shade(hue, 0.08)]]);
    const extra = opts.inner ?? '';
    this.raw(
      `<g transform="translate(${x} ${y}) scale(${s})">${back}<path d="${d}" fill="${face}" stroke="${shade(hue, 0.6)}" stroke-opacity=".55" stroke-width="${(0.45 / s).toFixed(2)}" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="${(0.5 / s).toFixed(2)}" transform="translate(-.15 -.15)" stroke-dasharray="${opts.rimDash ?? 'none'}"/>${extra}</g>`,
      [[x, y], [x + (w + depth) * s, y + (h + depth) * s]],
    );
  }

  sphere(cx, cy, z, r, hue) {
    const [x, y] = P(cx, cy, z);
    const id = this.id('r');
    this.defs.push(`<radialGradient id="${id}" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="${tint(hue, 0.6)}"/><stop offset=".55" stop-color="${hue}"/><stop offset="1" stop-color="${shade(hue, 0.45)}"/></radialGradient>`);
    this.raw(`<circle cx="${x}" cy="${y - r}" r="${r}" fill="url(#${id})" stroke="${shade(hue, 0.6)}" stroke-opacity=".5" stroke-width=".45"/>`, [[x - r, y - 2 * r], [x + r, y]]);
  }

  render() {
    // Contact shadow first (drawn under everything), then centre the drawing in 32×32.
    let shadowSvg = '';
    if (this.shadowFoot) {
      const { x0, y0, w, d } = this.shadowFoot;
      const [cx, cy] = P(x0 + w / 2, y0 + d / 2, 0);
      const rx = ((w + d) / 2) * COS * 1.05;
      const id = this.id('s');
      this.defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="#05060d" stop-opacity=".38"/><stop offset=".7" stop-color="#05060d" stop-opacity=".12"/><stop offset="1" stop-color="#05060d" stop-opacity="0"/></radialGradient>`);
      shadowSvg = `<ellipse cx="${cx.toFixed(2)}" cy="${(cy + 1.4).toFixed(2)}" rx="${rx.toFixed(2)}" ry="${(rx * 0.42).toFixed(2)}" fill="url(#${id})"/>`;
      this.track([[cx, cy + 1.4 + rx * 0.3]]);
    }
    const xs = this.points.map((p) => p[0]);
    const ys = this.points.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY);
    const scale = Math.min(1.25, 29 / span);
    const tx = 16 - ((minX + maxX) / 2) * scale;
    const ty = 16 - ((minY + maxY) / 2) * scale;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs>${this.defs.join('')}</defs><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(3)})">${shadowSvg}${this.layers.join('')}</g></svg>`;
    // Two decimals are far below a device pixel at icon sizes; this keeps assets small.
    return roundNumbers(svg);
  }
}

// ------------------------------------------------------------------ glyph helpers (flat, 2D)
export const W = (o = 0.95) => `fill="#fff" fill-opacity="${o}"`;
export const ink = (hue, o = 1) => `fill="${shade(hue, 0.55)}" fill-opacity="${o}"`;
export const line = (d, color, width = 1, opacity = 1) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;

