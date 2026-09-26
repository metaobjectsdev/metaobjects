// ADR-0034 Amendment 3 (2026-09-24 ruling) — ejecting a helper hands over ALL of its code.
//
// `meta eject routes` used to copy a generator whose OUTPUT still imported the HTTP adapter
// from `@metaobjectsdev/runtime-ts` — the mount helpers, filter parser, error envelopes and
// pagination, which is where most route defects have lived. Owning the generator while the
// code it emits calls into a package is half of owning it: a defect in the adapter still
// waits on an upstream release.
//
// So eject also copies the adapter SOURCE the output depends on — the transitive closure of
// relative imports from the entry module each generator's output names — into
// `codegen/runtime/`, laid out exactly as the package's own `src/` so every relative import
// in it resolves unchanged. Package imports are left as they are: what the closure reaches
// outside the package is `@metaobjectsdev/metadata` (core: the filter-op vocabulary and the
// canonical serializer) and third-party libraries (drizzle-orm, fastify, hono, zod, qs).
//
// The copies are VERBATIM. That is what makes "is my copy still the package's?" a byte
// comparison and "what did upstream change?" a plain `diff -r` against the installed
// package's `src/`, with no header to strip first.

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  HTTP_RUNTIME_MODULES,
  HTTP_RUNTIME_PACKAGE,
  OWNED_RUNTIME_DIR,
  type HttpRuntimeModule,
} from "@metaobjectsdev/codegen-ts";
import { compareOwnedCopy, type OwnedComparison } from "./owned-copy.js";
import { cliVersion } from "./version.js";

/**
 * The ejectable generators whose OUTPUT imports the adapter tier, and the adapter modules
 * it imports. `entity` is here for its allowlist TYPES only, which is one file.
 */
export const RUNTIME_ENTRIES: Readonly<Record<string, readonly HttpRuntimeModule[]>> = {
  routes: ["drizzle-fastify"],
  "routes-hono": ["hono"],
  entity: ["allowlists"],
};

/** True iff ejecting `name` also copies adapter source. */
export function ejectsRuntime(name: string): boolean {
  return Object.hasOwn(RUNTIME_ENTRIES, name);
}

interface RuntimePackage {
  /** `<root>/src` — the source the copies are taken from and compared against. */
  srcRoot: string;
  manifest: {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

/**
 * The installed `@metaobjectsdev/runtime-ts`: its `src/` and its manifest.
 *
 * Resolves the package ENTRY and walks up to the manifest that names it, never
 * `"<pkg>/package.json"`: the exports map does not export that subpath, and under real Node
 * asking for it throws ERR_PACKAGE_PATH_NOT_EXPORTED (see `install-set.ts`). `src/` ships
 * in the published package (`files: ["dist", "src", ...]`).
 */
export function resolveRuntimePackage(): RuntimePackage {
  const req = createRequire(import.meta.url);
  let dir = dirname(req.resolve(HTTP_RUNTIME_PACKAGE));
  for (let hops = 0; hops < 8; hops++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as RuntimePackage["manifest"] & { name?: string };
      if (manifest.name === HTTP_RUNTIME_PACKAGE) {
        const srcRoot = join(dir, "src");
        if (!existsSync(srcRoot)) {
          throw new Error(`${HTTP_RUNTIME_PACKAGE} at ${dir} ships no src/ — cannot copy the adapter source.`);
        }
        return { srcRoot, manifest };
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`could not locate the installed ${HTTP_RUNTIME_PACKAGE} package.`);
}

/** Relative (`./`, `../`) and bare module specifiers a source file imports or re-exports. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  // `import … from "x"` and the re-export forms (`export { … } from`, `export * from`) only —
  // a bare `export function f() { return Array.from("…") }` must not read as an import.
  const STATEMENT =
    /(?:^|\n)\s*(?:import\s+[^;"']*?\s+from|export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from)\s*["']([^"']+)["']/g;
  for (const m of source.matchAll(STATEMENT)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export interface RuntimeClosure {
  /** Source files, POSIX paths relative to the package's `src/`, sorted. */
  files: string[];
  /** Packages the closure imports (never `node:` builtins), sorted. */
  packages: string[];
}

/** Every file the given adapter modules reach through relative imports, and what else they import. */
export function runtimeClosure(srcRoot: string, modules: readonly HttpRuntimeModule[]): RuntimeClosure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = modules.map((m) => `${HTTP_RUNTIME_MODULES[m].file}.ts`);
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (files.has(rel)) continue;
    const abs = join(srcRoot, rel);
    if (!existsSync(abs)) {
      throw new Error(`${HTTP_RUNTIME_PACKAGE}: ${rel} is imported but not shipped in src/.`);
    }
    files.add(rel);
    for (const spec of specifiersOf(readFileSync(abs, "utf8"))) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = toPosix(join(dirname(rel), spec)).replace(/\.js$/, ".ts");
        queue.push(target.endsWith(".ts") ? target : `${target}.ts`);
      } else if (!spec.startsWith("node:")) {
        packages.add(packageNameOf(spec));
      }
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
}

export type RuntimeFileStatus = "created" | "preserved" | "replaced";

export interface RuntimeFileResult {
  /** Project-relative path of the copy. */
  path: string;
  status: RuntimeFileStatus;
  /** How the copy ALREADY on disk compared to the package's source. Absent when there was none. */
  comparison?: OwnedComparison | undefined;
}

export interface RuntimeEjectResult {
  files: RuntimeFileResult[];
  /** Packages the copied source imports — what the adopter now installs directly. */
  packages: string[];
}

/**
 * Copy the adapter source `names` emit imports of into `<cwd>/codegen/runtime/`.
 * Never overwrites a file without `force`, the same rule the generator copy keeps.
 */
export async function ejectRuntime(cwd: string, names: readonly string[], force: boolean): Promise<RuntimeEjectResult> {
  const modules = [...new Set(names.flatMap((n) => RUNTIME_ENTRIES[n] ?? []))];
  if (modules.length === 0) return { files: [], packages: [] };
  const { srcRoot } = resolveRuntimePackage();
  const closure = runtimeClosure(srcRoot, modules);
  const files: RuntimeFileResult[] = [];
  for (const rel of closure.files) {
    const source = await readFile(join(srcRoot, rel), "utf8");
    const path = `${OWNED_RUNTIME_DIR}/${rel}`;
    const abs = join(cwd, path);
    const existing = existsSync(abs) ? await readFile(abs, "utf8") : undefined;
    const comparison = existing === undefined ? undefined : await compareOwnedCopy(existing, source);
    if (existing !== undefined && !force) {
      files.push({ path, status: "preserved", comparison });
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, source, "utf8");
    files.push({ path, status: existing === undefined ? "created" : "replaced", comparison });
  }
  return { files, packages: closure.packages };
}

/**
 * The install lines the copied source needs, with ranges read from the runtime package's
 * own manifest (never restated here). A `@metaobjectsdev/*` package moves with the CLI.
 * A package that ships no types of its own gets its `@types/*` sibling as a dev dependency
 * when the runtime package itself develops against one.
 */
export function runtimeInstall(packages: readonly string[]): {
  runtime: Map<string, string | undefined>;
  dev: Map<string, string | undefined>;
} {
  const { manifest } = resolveRuntimePackage();
  const known = { ...manifest.peerDependencies, ...manifest.dependencies };
  const runtime = new Map<string, string | undefined>();
  const dev = new Map<string, string | undefined>();
  for (const p of packages) {
    runtime.set(p, p.startsWith("@metaobjectsdev/") ? `^${cliVersion()}` : known[p]);
    const typesPkg = `@types/${p.replace(/^@/, "").replace("/", "__")}`;
    const typesRange = manifest.devDependencies?.[typesPkg];
    if (typesRange !== undefined) dev.set(typesPkg, typesRange);
  }
  return { runtime, dev };
}

/** One owned adapter file, compared to the package it came from. */
export interface RuntimeCopyRow {
  path: string;
  verdict: OwnedComparison["verdict"] | "not-in-package";
  localOnly: number;
  referenceOnly: number;
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
 * Every file under `<cwd>/codegen/runtime/`, compared to the installed package's source.
 * Empty when the project owns no adapter copy. `not-in-package` is a file the package does
 * not ship — your own addition, or one upstream deleted or renamed.
 */
export async function runtimeCopyStatus(cwd: string): Promise<RuntimeCopyRow[]> {
  const root = join(cwd, OWNED_RUNTIME_DIR);
  if (!existsSync(root)) return [];
  let srcRoot: string;
  try {
    srcRoot = resolveRuntimePackage().srcRoot;
  } catch {
    return [];
  }
  const rows: RuntimeCopyRow[] = [];
  for (const abs of listTs(root).sort()) {
    const rel = toPosix(relative(root, abs));
    const path = `${OWNED_RUNTIME_DIR}/${rel}`;
    const upstream = join(srcRoot, rel);
    if (!existsSync(upstream)) {
      rows.push({ path, verdict: "not-in-package", localOnly: 0, referenceOnly: 0 });
      continue;
    }
    const cmp = await compareOwnedCopy(readFileSync(abs, "utf8"), readFileSync(upstream, "utf8"));
    rows.push({ path, verdict: cmp.verdict, localOnly: cmp.localOnly, referenceOnly: cmp.referenceOnly });
  }
  return rows;
}

/** The command that shows exactly how one owned file differs from the installed package's. */
export function runtimeDiffCommand(path: string): string {
  const rel = path.startsWith(`${OWNED_RUNTIME_DIR}/`) ? path.slice(OWNED_RUNTIME_DIR.length + 1) : path;
  return `diff -u node_modules/${HTTP_RUNTIME_PACKAGE}/src/${rel} ${OWNED_RUNTIME_DIR}/${rel}`;
}
