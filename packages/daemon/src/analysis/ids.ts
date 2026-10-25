/**
 * Node ids are stateless descriptions of *where* something is, so any id can be
 * re-resolved against the current source at any time (and goes stale honestly
 * when the file changes).
 */
export type LocatedKind = 'fn' | 'jsx' | 'http' | 'route' | 'sql' | 'orm' | 'cls';

export type NodeRef =
  | { t: LocatedKind; file: string; line: number; col: number }
  | { t: 'ext'; module: string; name: string }
  | { t: 'state'; file: string; line: number; col: number }
  | { t: 'unres'; text: string; file: string; line: number };

export function located(t: LocatedKind | 'state', file: string, line: number, col: number) {
  return `${t}:${file}:${line}:${col}`;
}

export function extId(module: string, name: string) {
  return `ext:${module}#${name}`;
}

export function unresId(file: string, line: number, text: string) {
  return `unres:${file}:${line}#${text}`;
}

export function parseId(id: string): NodeRef {
  const colon = id.indexOf(':');
  const t = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (t === 'ext') {
    const hash = rest.lastIndexOf('#');
    return { t, module: rest.slice(0, hash), name: rest.slice(hash + 1) };
  }
  if (t === 'unres') {
    const hash = rest.indexOf('#');
    const [file, line] = splitLoc(rest.slice(0, hash), 1);
    return { t, file, line: Number(line), text: rest.slice(hash + 1) };
  }
  const [file, line, col] = splitLoc(rest, 2);
  if (!['fn', 'jsx', 'http', 'route', 'sql', 'orm', 'cls', 'state'].includes(t)) throw new Error(`Unknown node id: ${id}`);
  return { t: t as LocatedKind, file, line: Number(line), col: Number(col) };
}

/** Split `a/b.ts:12:4` from the right so paths containing ':' survive. */
function splitLoc(s: string, n: number): string[] {
  const parts = s.split(':');
  const tail = parts.splice(parts.length - n, n);
  return [parts.join(':'), ...tail];
}

/** `web/src/App.tsx:12:4` → parts. */
export function parseLoc(loc: string) {
  const [file, line, col] = splitLoc(loc, 2);
  return { file, line: Number(line), col: Number(col) };
}
