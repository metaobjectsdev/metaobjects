// ADR-0034 Amendment 8 — ejecting a generator hands over ALL of the code that writes its output.
//
// A reference generator (`src/reference/<name>.ts`) is the part an adopter decides things in:
// which nodes get a file, where it lands, in what order. The text of each file is written by
// the template modules it calls (`src/templates/*.ts`, `src/cube/*`, `src/generators/*`, in the
// three codegen packages), and those used to stay in the package: an owned `entity` was 223
// lines over 3,484 packaged ones, and a defect in what it emitted still waited on an upstream
// release. So eject also copies the TRANSITIVE CLOSURE of those modules into
// `codegen/templates/`, the way it copies the HTTP adapter into `codegen/runtime/`
// (runtime-eject.ts), and the owned generator imports them from there.
//
// What stays packaged is the ENGINE (`ENGINE_MODULES`): the generator base, the model walks,
// and the naming and type-mapping tables. A copied module reaches those through its package's
// public entry. That is the one edit a copy makes: every module specifier is rewritten, and
// nothing else in the file is touched, so "what did upstream change?" is a diff of two files
// that differ in their import lines only.
//
//   ./names.js, ../column-mapper.js        an ENGINE module        -> "@metaobjectsdev/codegen-ts"
//   ./zod-validators.js, ../cube/x.js      an EMIT module          -> the copy beside it
//   @metaobjectsdev/codegen-ts/templates/x another package's emit  -> the copy beside it
//   ts-poet                                the package's own Code  -> "@metaobjectsdev/codegen-ts"
//
// The last row is the 0.21.6 split-tree defect: `Code` objects are recognised by `instanceof`,
// so a copy must build them with the same ts-poet the engine uses.
//
// Imports are found by scanning the leading import block of each module — the only place these
// files declare a module specifier. A scanner and not a regex over the whole file because the
// template modules hold text that LOOKS like an import inside their template literals. The
// scanner is held to the TypeScript compiler's own reading of every closure module in
// test/template-eject.test.ts.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";
import { compareOwnedCopy, type OwnedComparison } from "./owned-copy.js";

const { ENGINE_MODULES } = coreTpl;

/** A codegen package's shipped source: `<root>/src`, with its `reference/` directory inside. */
export interface PackageSource {
  /** `@metaobjectsdev/codegen-ts`, `@metaobjectsdev/codegen-ts-react`, … */
  name: string;
  /** `<package root>/src` — what the copies are taken from. */
  srcRoot: string;
}

const SCOPE = "@metaobjectsdev/";
/** Where the copied template modules land, relative to the project root. */
export const OWNED_TEMPLATES_DIR = "codegen/templates";
const OWNED_GENERATORS_DIR = "codegen/generators";
/** The package whose public entry an owned copy imports the engine from, and the ts-poet it shares. */
const CORE_PACKAGE = `${SCOPE}codegen-ts`;

/** `@metaobjectsdev/codegen-ts-react` → `codegen-ts-react`, the directory spelling `ENGINE_MODULES` uses. */
function shortName(pkg: string): string {
  return pkg.startsWith(SCOPE) ? pkg.slice(SCOPE.length) : pkg;
}

// ---------------------------------------------------------------------------
// reading a module's import block
// ---------------------------------------------------------------------------

/** One module specifier in a source file: the text between the quotes, and where it sits. */
export interface ImportRef {
  spec: string;
  /** Offsets of the specifier text, excluding the quotes. */
  start: number;
  end: number;
}

const IDENT = /[A-Za-z0-9_$]/;

/**
 * Every module specifier in the leading import block of `source`: `import … from "x"`,
 * `import "x"` and `export … from "x"`, up to the first statement that is none of those.
 *
 * Within that block there are only comments, string literals, braces and identifiers, which
 * is why a scanner this small is sound: no template literal and no regular expression can
 * occur before the first real statement.
 */
export function importRefs(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const n = source.length;
  let i = 0;

  const skipTrivia = (): void => {
    for (;;) {
      const c = source[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else if (c === "/" && source[i + 1] === "/") {
        while (i < n && source[i] !== "\n") i++;
      } else if (c === "/" && source[i + 1] === "*") {
        const close = source.indexOf("*/", i + 2);
        i = close === -1 ? n : close + 2;
      } else return;
    }
  };
  const word = (): string => {
    const from = i;
    while (i < n && IDENT.test(source[i]!)) i++;
    return source.slice(from, i);
  };
  const peekWord = (): string => {
    const save = i;
    const w = word();
    i = save;
    return w;
  };
  /** Read a quoted string at `i`; record it as a specifier. */
  const specifier = (): void => {
    const quote = source[i]!;
    const close = source.indexOf(quote, i + 1);
    if (close === -1) throw new Error("unterminated module specifier");
    refs.push({ spec: source.slice(i + 1, close), start: i + 1, end: close });
    i = close + 1;
  };
  const endStatement = (): void => {
    skipTrivia();
    if (source[i] === ";") i++;
  };

  /**
   * After `import` / `export`: skip the clause to its `from` and read the specifier.
   * Returns false when the statement has none (`export const …`, `export { a };`).
   */
  const clause = (): boolean => {
    let depth = 0;
    for (;;) {
      skipTrivia();
      if (i >= n) return false;
      const c = source[i]!;
      if (c === '"' || c === "'") {
        specifier(); // `import "x"` — a bare side-effect import
        return true;
      }
      if (c === "{") { depth++; i++; continue; }
      if (c === "}") { depth--; i++; continue; }
      if (c === "," || c === "*" || c === "=") { i++; continue; }
      if (c === ";") return false;
      if (IDENT.test(c)) {
        const w = word();
        if (w === "from" && depth === 0) {
          skipTrivia();
          if (source[i] === '"' || source[i] === "'") { specifier(); return true; }
          return false;
        }
        continue;
      }
      return false;
    }
  };

  for (;;) {
    skipTrivia();
    const w = peekWord();
    if (w === "import") {
      i += w.length;
      // `import("x")` and `import.meta` are expressions, which is the end of the block.
      skipTrivia();
      if (source[i] === "(" || source[i] === ".") return refs;
      if (!clause()) return refs;
      endStatement();
    } else if (w === "export") {
      i += w.length;
      skipTrivia();
      const next = peekWord();
      if (next === "type") i += next.length;
      skipTrivia();
      if (source[i] !== "*" && source[i] !== "{") return refs;
      const save = refs.length;
      if (!clause() || refs.length === save) return refs;
      endStatement();
    } else {
      return refs;
    }
  }
}

/** `source` with each specifier in `refs` replaced by `replace(spec)` — nothing else is touched. */
function rewriteImports(source: string, refs: readonly ImportRef[], replace: (spec: string) => string): string {
  let out = source;
  for (const r of [...refs].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + replace(r.spec) + out.slice(r.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the closure
// ---------------------------------------------------------------------------

/** One module of a codegen package, by package and path under its `src/`. */
interface SourceModule {
  pkg: PackageSource;
  /** POSIX path under `src/`: `templates/entity-file.ts`. */
  rel: string;
}

/** The spelling `ENGINE_MODULES` uses: `codegen-ts/src/templates/find-inbound.ts`. */
function keyOf(m: SourceModule): string {
  return `${shortName(m.pkg.name)}/src/${m.rel}`;
}

const ENGINE: ReadonlySet<string> = new Set(ENGINE_MODULES);

/** Where a template module's copy lands: `templates/x.ts` → `codegen/templates/x.ts`, `cube/y.ts` → `codegen/templates/cube/y.ts`. */
function destinationOf(m: SourceModule): string {
  const rel = m.rel.startsWith("templates/") ? m.rel.slice("templates/".length) : m.rel;
  return `${OWNED_TEMPLATES_DIR}/${rel}`;
}

function sourceOf(m: SourceModule): string {
  return readFileSync(posix.join(m.pkg.srcRoot.split("\\").join("/"), m.rel), "utf8");
}

/** The module `spec` names, imported from `from`, or undefined when it is not one of ours. */
function resolveModule(packages: readonly PackageSource[], from: SourceModule, spec: string): SourceModule | undefined {
  const find = (pkg: PackageSource, rel: string): SourceModule => {
    for (const candidate of [rel.replace(/\.js$/, ".ts"), `${rel}.ts`, `${rel}/index.ts`]) {
      if (existsSync(posix.join(pkg.srcRoot.split("\\").join("/"), candidate))) return { pkg, rel: candidate };
    }
    throw new Error(
      `${keyOf(from)} imports "${spec}", which is not a module of ${pkg.name}. ` +
        "Only TypeScript modules can be handed over with a generator.",
    );
  };
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return find(from.pkg, posix.normalize(posix.join(posix.dirname(from.rel), spec)));
  }
  // `@metaobjectsdev/codegen-ts/templates/x` — another codegen package's emit module, by path.
  const sub = /^(@metaobjectsdev\/[\w-]+)\/(templates\/[\w-]+)$/.exec(spec);
  if (sub !== null) {
    const pkg = packages.find((p) => p.name === sub[1]);
    if (pkg !== undefined) return find(pkg, `${sub[2]}.ts`);
  }
  return undefined;
}

/** One file an eject writes. */
export interface OwnedFile {
  /** Project-relative POSIX path. */
  path: string;
  /** What is written: the package's source with its module specifiers rewritten. */
  content: string;
  /** The packaged module it comes from, in the manifest's spelling. */
  origin: string;
}

export interface TemplateClosure {
  /** The owned generator itself. */
  generator: OwnedFile;
  /** The template modules it calls, transitively, sorted by path. */
  templates: OwnedFile[];
  /** Every package the written files import — what the adopter's project must be able to resolve. */
  packages: string[];
}

/**
 * The owned form of one reference generator: the generator file and every template module it
 * reaches, each with its module specifiers pointed at the project.
 *
 * `pkg` is the package the reference ships in; `packages` is every codegen package, since a
 * client-tier reference reaches template modules in the core one.
 */
export function templateClosure(
  packages: readonly PackageSource[],
  pkg: PackageSource,
  name: string,
  /** The modules that stay packaged. The tests hand in a smaller set than the shipped one. */
  engine: ReadonlySet<string> = ENGINE,
): TemplateClosure {
  const reference: SourceModule = { pkg, rel: `reference/${name}.ts` };
  const destination = (m: SourceModule): string =>
    m.rel === reference.rel && m.pkg === reference.pkg ? `${OWNED_GENERATORS_DIR}/${name}.ts` : destinationOf(m);

  // Breadth-first over the specifiers: an engine module ends a path, anything else is copied.
  const members = new Map<string, SourceModule>([[keyOf(reference), reference]]);
  const queue = [reference];
  while (queue.length > 0) {
    const module = queue.shift()!;
    for (const ref of importRefs(sourceOf(module))) {
      const target = resolveModule(packages, module, ref.spec);
      if (target === undefined || engine.has(keyOf(target)) || members.has(keyOf(target))) continue;
      members.set(keyOf(target), target);
      queue.push(target);
    }
  }

  // Two packaged modules must not land on one path; the layout drops a directory level.
  const owners = new Map<string, string>();
  for (const [key, m] of members) {
    const dest = destination(m);
    const other = owners.get(dest);
    if (other !== undefined) throw new Error(`${other} and ${key} would both be copied to ${dest}.`);
    owners.set(dest, key);
  }

  const imported = new Set<string>();
  const render = (m: SourceModule): OwnedFile => {
    const source = sourceOf(m);
    const here = destination(m);
    const content = rewriteImports(source, importRefs(source), (spec) => {
      const target = resolveModule(packages, m, spec);
      let next = spec;
      if (target !== undefined) {
        next = engine.has(keyOf(target))
          ? target.pkg.name
          : relativeSpecifier(here, destination(target));
      } else if (spec === "ts-poet") {
        next = CORE_PACKAGE;
      }
      if (!next.startsWith(".") && !next.startsWith("node:")) imported.add(packageOfSpecifier(next));
      return next;
    });
    return { path: here, content, origin: keyOf(m) };
  };

  const rendered = [...members.values()].map(render);
  const generator = rendered.find((f) => f.path === `${OWNED_GENERATORS_DIR}/${name}.ts`)!;
  const templates = rendered.filter((f) => f !== generator).sort((a, b) => a.path.localeCompare(b.path));
  return { generator, templates, packages: [...imported].sort() };
}

/** `./x.js` / `../y/z.js` from the file at `from` to the one at `to`, both project-relative. */
function relativeSpecifier(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to).replace(/\.ts$/, ".js");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageOfSpecifier(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

// ---------------------------------------------------------------------------
// handing the copies over
// ---------------------------------------------------------------------------

export type TemplateFileStatus = "created" | "preserved" | "replaced";

export interface TemplateFileResult {
  /** Project-relative path of the copy. */
  path: string;
  status: TemplateFileStatus;
  /** How the copy ALREADY on disk compared to what the package would write. Absent when there was none. */
  comparison?: OwnedComparison | undefined;
}

export interface TemplateEjectResult {
  files: TemplateFileResult[];
}

/**
 * Write the template modules of `closures` into `<cwd>/codegen/templates/`. Never overwrites a
 * file without `force`, the rule the generator copy keeps: two generators that call the same
 * module share one copy, and re-running eject fills in what is missing without touching what
 * the adopter has changed.
 */
export async function ejectTemplates(
  cwd: string,
  closures: readonly TemplateClosure[],
  force: boolean,
): Promise<TemplateEjectResult> {
  const wanted = new Map<string, OwnedFile>();
  for (const closure of closures) {
    for (const file of closure.templates) {
      const seen = wanted.get(file.path);
      // One packaged module, one copy: the rewrite depends on the module alone.
      if (seen !== undefined && seen.content !== file.content) {
        throw new Error(`${file.path} would be written with two different contents (${seen.origin}, ${file.origin}).`);
      }
      wanted.set(file.path, file);
    }
  }
  const files: TemplateFileResult[] = [];
  for (const file of [...wanted.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const abs = join(cwd, file.path);
    const existing = existsSync(abs) ? await readFile(abs, "utf8") : undefined;
    const comparison = existing === undefined ? undefined : await compareOwnedCopy(existing, file.content);
    if (existing !== undefined && !force) {
      files.push({ path: file.path, status: "preserved", comparison });
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    files.push({ path: file.path, status: existing === undefined ? "created" : "replaced", comparison });
  }
  return { files };
}

/**
 * True when a kept generator file calls none of the template modules its reference now calls.
 * Such a copy predates the hand-over (1.1): it still imports the emit code from the package,
 * so copying the modules beside it would be dead code. Re-ejecting it with `--force` is the
 * way to take the new shape.
 */
export function predatesTemplateHandOver(existing: string, closure: TemplateClosure): boolean {
  if (closure.templates.length === 0) return false;
  const called = importRefs(closure.generator.content)
    .map((r) => r.spec)
    .filter((spec) => spec.startsWith("."));
  return called.length > 0 && !called.some((spec) => existing.includes(`"${spec}"`));
}

/** One owned template file, compared to the package it came from. */
export interface TemplateCopyRow {
  path: string;
  verdict: OwnedComparison["verdict"] | "not-in-package";
  localOnly: number;
  referenceOnly: number;
  /** The packaged module it was copied from, when there is one. */
  origin?: string | undefined;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listTs(abs));
    else if (entry.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Every file under `<cwd>/codegen/templates/`, compared to what the installed package would
 * write there today. Empty when the project owns no template copy. `not-in-package` is a file
 * the package would not write: your own addition, or one upstream deleted or renamed.
 */
export async function templateCopyStatus(cwd: string, upstream: ReadonlyMap<string, OwnedFile>): Promise<TemplateCopyRow[]> {
  const root = join(cwd, OWNED_TEMPLATES_DIR);
  if (!existsSync(root)) return [];
  const rows: TemplateCopyRow[] = [];
  for (const abs of listTs(root).sort()) {
    const path = relative(cwd, abs).split(sep).join("/");
    const packaged = upstream.get(path);
    if (packaged === undefined) {
      rows.push({ path, verdict: "not-in-package", localOnly: 0, referenceOnly: 0 });
      continue;
    }
    const cmp = await compareOwnedCopy(readFileSync(abs, "utf8"), packaged.content);
    rows.push({ path, verdict: cmp.verdict, localOnly: cmp.localOnly, referenceOnly: cmp.referenceOnly, origin: packaged.origin });
  }
  return rows;
}

/** The command that shows exactly how one owned template file differs from the installed package's. */
export function templateDiffCommand(row: TemplateCopyRow): string | undefined {
  if (row.origin === undefined) return undefined;
  const [short, ...rest] = row.origin.split("/");
  return `diff -u node_modules/${SCOPE}${short}/${rest.join("/")} ${row.path}`;
}

// ---------------------------------------------------------------------------
// the installed packages
// ---------------------------------------------------------------------------

interface ReferenceSource {
  /** The codegen package whose `src/reference/` holds the generator. */
  pkg: PackageSource;
  names: readonly string[];
}

let installed: ReferenceSource[] | undefined;

/** The three codegen packages, as installed: their shipped `src/` and the generators each ships a reference for. */
function installedSources(): ReferenceSource[] {
  installed ??= [
    [`${SCOPE}codegen-ts`, coreTpl],
    [`${SCOPE}codegen-ts-react`, reactTpl],
    [`${SCOPE}codegen-ts-tanstack`, tanstackTpl],
  ].map(([name, tpl]) => {
    const t = tpl as typeof coreTpl;
    return { pkg: { name: name as string, srcRoot: dirname(t.resolveReferenceRoot()) }, names: t.REFERENCE_GENERATOR_NAMES };
  });
  return installed;
}

/** The three codegen packages' shipped source — where the template modules a reference calls live. */
export function codegenPackages(): PackageSource[] {
  return installedSources().map((s) => s.pkg);
}

const closures = new Map<string, TemplateClosure>();

/**
 * The owned form of one reference generator, from the installed packages: the generator file
 * and the template modules it calls, with their module specifiers pointed at the project.
 * Memoized — the installed source does not change under a running command.
 */
export function closureOf(name: string): TemplateClosure {
  let closure = closures.get(name);
  if (closure === undefined) {
    const sources = installedSources();
    const source = sources.find((s) => s.names.includes(name));
    if (source === undefined) throw new Error(`no reference generator named "${name}".`);
    closure = templateClosure(sources.map((s) => s.pkg), source.pkg, name);
    closures.set(name, closure);
  }
  return closure;
}

/** Every ejectable name, across the three packages, in registry order. */
export function referenceNames(): string[] {
  return installedSources().flatMap((s) => s.names);
}

/** Every file `meta eject` would write for a template module, across every ejectable generator. */
export function packagedTemplates(): Map<string, OwnedFile> {
  const all = new Map<string, OwnedFile>();
  for (const name of referenceNames()) {
    for (const file of closureOf(name).templates) all.set(file.path, file);
  }
  return all;
}
