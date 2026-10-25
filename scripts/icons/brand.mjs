// TraceNaut brand mark: glass layers of a running system with a pointer on top (inspect an
// element, see the layers beneath). The artwork is raster (glossy glass does not reduce to
// flat vector shapes), so the PNGs in packages/assets/src/brand are the source of truth and
// the SVG variants wrap them for the <img>-based icon pipeline.
//
//   tracenaut-mark.png   master, transparent background
//   mark-{16…512}.png    downscaled exports (≤ 48 px lightly sharpened)
//   mono-{light,dark}    single-colour versions for light / dark grounds
import { readFileSync } from 'node:fs';

const SRC = new URL('../../packages/assets/src/brand/', import.meta.url).pathname;
export const BRAND_SRC = SRC;
export const BRAND = { indigo: '#5b5bd6', cyan: '#22d3ee', ink: '#14162b' };

const png = (file) => `data:image/png;base64,${readFileSync(`${SRC}${file}`).toString('base64')}`;
const wrap = (file, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><image width="${size}" height="${size}" href="${png(file)}"/></svg>`;

/** `color` embeds the 128 px export (sharp up to 64 px on 2× screens); `favicon` the 32 px one. */
export function markSvg(variant = 'color') {
  if (variant === 'favicon') return wrap('mark-32.png', 32);
  if (variant === 'mono-light' || variant === 'mono-dark') return wrap(`${variant}-256.png`, 64);
  return wrap('mark-128.png', 64);
}
