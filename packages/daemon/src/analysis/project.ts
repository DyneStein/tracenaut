import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS, type ServiceConfig, type Workspace, toAbs, toRel } from '../workspace.js';

const SOURCE_EXT = /\.(m|c)?[jt]sx?$/;
const MAX_FILES = 8000;

/**
 * One TypeScript language service per service. TypeScript's checker understands
 * both TS and JS (allowJs), so it gives real symbol resolution — imports, re-exports,
 * namespaces, destructuring — instead of name matching.
 */
export class ServiceProject {
  readonly ls: ts.LanguageService;
  private readonly options: ts.CompilerOptions;
  private fileNames: string[];

  constructor(
    readonly ws: Workspace,
    readonly service: ServiceConfig,
  ) {
    const root = toAbs(ws, service.root);
    const parsed = readConfig(root);
    this.options = { ...parsed.options, noEmit: true, allowJs: true, checkJs: false };
    this.fileNames = parsed.fileNames.length ? parsed.fileNames : listSources(root);

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.options,
      getScriptFileNames: () => this.fileNames,
      getScriptVersion: (f) => {
        try {
          return String(statSync(f).mtimeMs);
        } catch {
          return '0';
        }
      },
      getScriptSnapshot: (f) => {
        if (!existsSync(f)) return undefined;
        return ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8'));
      },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private cached?: { program: ts.Program; at: number };

  /**
   * The current program. Asking the language service re-checks every file's modification
   * time, which dominated analysis time on large repositories (one stat per file per symbol
   * lookup). Within a burst of work the same program is reused; files are re-checked at most
   * once per second, so edits are still picked up on the next interaction.
   */
  program() {
    const now = Date.now();
    if (this.cached && now - this.cached.at < 1000) return this.cached.program;
    const p = this.ls.getProgram();
    if (!p) throw new Error(`TypeScript could not build a program for service ${this.service.name}`);
    this.cached = { program: p, at: now };
    return p;
  }

  checker() {
    return this.program().getTypeChecker();
  }

  sourceFile(relFile: string) {
    return this.program().getSourceFile(toAbs(this.ws, relFile));
  }

  rel(sf: ts.SourceFile) {
    return toRel(this.ws, sf.fileName);
  }

  /** Source files that belong to the user's code (not libraries / declaration files). */
  userSourceFiles() {
    return this.program()
      .getSourceFiles()
      .filter((sf) => isUserFile(sf.fileName) && sf.fileName.startsWith(this.ws.repoRoot));
  }
}

export function isUserFile(fileName: string) {
  return !fileName.includes('/node_modules/') && !fileName.endsWith('.d.ts') && SOURCE_EXT.test(fileName);
}

function readConfig(root: string): { options: ts.CompilerOptions; fileNames: string[] } {
  const configPath = path.join(root, 'tsconfig.json');
  const fallback: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    skipLibCheck: true,
  };
  if (!existsSync(configPath)) return { options: fallback, fileNames: [] };

  const parse = (p: string) =>
    ts.getParsedCommandLineOfConfigFile(p, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const parsed = parse(configPath);
  if (!parsed) return { options: fallback, fileNames: [] };
  if (parsed.fileNames.length > 0) return { options: parsed.options, fileNames: parsed.fileNames };

  // Solution-style config (e.g. Vite templates): merge the referenced projects.
  const fileNames: string[] = [];
  let options = parsed.options;
  for (const ref of parsed.projectReferences ?? []) {
    const refPath = ts.resolveProjectReferencePath(ref);
    const sub = existsSync(refPath) ? parse(refPath) : undefined;
    if (!sub) continue;
    if (fileNames.length === 0) options = sub.options;
    fileNames.push(...sub.fileNames);
  }
  return { options, fileNames };
}

function listSources(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    for (const entry of readdirSync(dir)) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}
