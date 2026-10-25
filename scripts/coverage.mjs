// Prints the technology coverage matrix (Markdown) from the asset registry, so the table in
// docs/COVERAGE.md always matches what the code declares.
//   node scripts/coverage.mjs > /tmp/matrix.md
import { CATEGORIES, LEVELS, TECHNOLOGIES, supportOf } from '../packages/assets/src/index.mjs';

const byCat = new Map();
for (const t of TECHNOLOGIES) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
const cols = LEVELS.map((l) => l.short);
const out = [`| Technology | Kind | ${cols.join(' | ')} |`, `|---|---|${cols.map(() => ':-:').join('|')}|`];
for (const [cat, label] of Object.entries(CATEGORIES)) {
  const list = byCat.get(cat);
  if (!list) continue;
  out.push(`| **${label}** | | ${cols.map(() => '').join(' | ')} |`);
  for (const t of list) {
    const s = supportOf(t);
    out.push(`| ${t.name}${t.logo ? '' : ' ¹'} | ${t.kind} | ${LEVELS.map((l) => (s[l.id] ? '✓' : '·')).join(' | ')} |`);
  }
}
const totals = LEVELS.map((l) => `${l.short} ${TECHNOLOGIES.filter((t) => supportOf(t)[l.id]).length}`).join(' · ');
console.log(out.join('\n'));
console.log(`\n${TECHNOLOGIES.length} technologies · ${totals}\n\n¹ No official logo is used (licence or availability); TraceNaut's conceptual icon is shown instead.`);
