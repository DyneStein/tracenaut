import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS, type Workspace } from '../workspace.js';

/**
 * Prisma model operations: `prisma.user.findUnique(…)`, `db.client.website.update(…)`.
 *
 * Prisma's client is generated code, often missing from a fresh checkout, so the call is
 * recognised by its shape and confirmed against the schema: the property before the
 * operation must be a model declared in a `.prisma` schema file. When TypeScript can see
 * the generated client (the receiver's type is a Prisma model delegate) the link is
 * static; otherwise it rests on the names matching and is reported as inferred.
 */

const READ_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WRITE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

export interface OrmCall {
  orm: 'Prisma';
  /** Model as declared in the schema, e.g. `Website`. */
  model: string;
  op: string;
  access: 'read' | 'write';
  evidence: 'static' | 'inferred';
  schemaFile: string;
}

interface Schema {
  /** lowerCamel delegate name → declared model name. */
  models: Map<string, string>;
  file: string;
}

const schemas = new Map<string, Schema | null>();

function findSchemaFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || out.length > 40) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e) || e.startsWith('.')) continue;
      const full = path.join(dir, e);
      if (e.endsWith('.prisma')) out.push(full);
      else {
        try {
          if (statSync(full).isDirectory()) walk(full, depth + 1);
        } catch {
          // unreadable entry
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export function prismaSchema(ws: Workspace): Schema | undefined {
  const hit = schemas.get(ws.repoRoot);
  if (hit !== undefined) return hit ?? undefined;
  const models = new Map<string, string>();
  let file = '';
  for (const f of findSchemaFiles(ws.repoRoot)) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)) {
      models.set(m[1][0].toLowerCase() + m[1].slice(1), m[1]);
      file ||= path.relative(ws.repoRoot, f).split(path.sep).join('/');
    }
  }
  const schema = models.size ? { models, file } : null;
  schemas.set(ws.repoRoot, schema);
  return schema ?? undefined;
}

export function prismaCall(call: ts.CallExpression, ws: Workspace, checker: ts.TypeChecker): OrmCall | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const op = callee.name.text;
  const access = READ_OPS.has(op) ? 'read' : WRITE_OPS.has(op) ? 'write' : undefined;
  if (!access) return undefined;
  const delegate = callee.expression;
  if (!ts.isPropertyAccessExpression(delegate)) return undefined; // `website.findMany` alone is too weak
  const schema = prismaSchema(ws);
  const model = schema?.models.get(delegate.name.text);
  if (!schema || !model) return undefined;
  const typeName = checker.typeToString(checker.getTypeAtLocation(delegate));
  const typed = /Delegate\b/.test(typeName) && typeName.includes(model);
  return { orm: 'Prisma', model, op, access, evidence: typed ? 'static' : 'inferred', schemaFile: schema.file };
}

export function ormPhrase(c: { model: string; op: string; access: 'read' | 'write' }) {
  if (c.op.startsWith('count')) return `count ${c.model}`;
  if (c.access === 'read') return `read ${c.model}`;
  if (c.op.startsWith('create')) return `add to ${c.model}`;
  if (c.op.startsWith('delete')) return `remove from ${c.model}`;
  if (c.op === 'upsert') return `add or change ${c.model}`;
  return `change ${c.model}`;
}
