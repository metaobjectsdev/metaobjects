// Where generated code imports the HTTP-adapter tier from — the package, or a copy the
// adopter owns.
//
// ADR-0034 Amendment 3 (2026-09-24 ruling) puts the HTTP adapters that mount a CRUD
// surface on a web framework — `@metaobjectsdev/runtime-ts`'s `./drizzle-fastify` and
// `./hono` entries, with the filter parser, error envelopes and pagination they carry —
// on the HELPER side of the line. A helper is something the adopter owns. Owning the
// routes GENERATOR while its output still imports the adapter from the package is half
// of that: a defect in the adapter still waits on an upstream release.
//
// So `meta eject routes` (and `routes-hono`, and `entity`, whose allowlist TYPES come
// from the same tier) also copies the adapter SOURCE into the adopter's repo, and the
// ejected generators point their emitted imports at that copy. This module is the one
// place both halves agree on how that import is spelled.
//
// The package grammar stays the default everywhere in the engine: a RenderContext with
// no `httpRuntimeImport` emits exactly what it always did, so a project that has not
// ejected sees no change.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { relativeModuleSpecifier, type OutputLayout } from "./import-path.js";
import type { ExtStyle } from "./render-context.js";

/** The package the HTTP-adapter tier ships in. */
export const HTTP_RUNTIME_PACKAGE = "@metaobjectsdev/runtime-ts";

/**
 * Where `meta eject` puts the adapter source it copies, relative to the project root —
 * beside `codegen/generators/`, which is where the generators that import it live.
 * The copy mirrors the package's own `src/` layout, so its relative imports resolve
 * unchanged and a `diff -r` against the package's `src/` compares like with like.
 */
export const OWNED_RUNTIME_DIR = "codegen/runtime";

/**
 * Each adapter module a generated file imports: its package SUBPATH (what the package
 * exports) and its SOURCE file within the copied tree (extensionless — the import
 * style adds one). `allowlists` is the entity module's type-only import: in the package
 * it rides the `./drizzle-fastify` entry, but a copy points at the one file that
 * declares the types, so an entity module does not drag Fastify into a Hono project.
 */
export const HTTP_RUNTIME_MODULES = {
  "drizzle-fastify": { subpath: "drizzle-fastify", file: "drizzle-fastify/index" },
  hono: { subpath: "hono", file: "hono/index" },
  allowlists: { subpath: "drizzle-fastify", file: "drizzle-fastify/filter-allowlist" },
} as const;

export type HttpRuntimeModule = keyof typeof HTTP_RUNTIME_MODULES;

/** The render facts {@link httpRuntimeSpecifier} reads — a subset of `RenderContext`. */
export interface HttpRuntimeSpecifierCtx {
  /**
   * Where the adapter tier is imported from. Undefined (the default) = the package.
   * A RELATIVE value (`./…`, `../…`) is relative to the target's output root, like
   * `dbImport`, and names the root of a copied tree. Any other value is either the
   * package name or a path alias for the root of a copied tree.
   */
  httpRuntimeImport?: string | undefined;
  outputLayout: OutputLayout;
  extStyle: ExtStyle;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * The import specifier for one adapter module, as seen from a generated file in
 * package `pkg` (which decides the `../` depth under the `package` output layout).
 */
export function httpRuntimeSpecifier(
  module: HttpRuntimeModule,
  ctx: HttpRuntimeSpecifierCtx,
  pkg: string | undefined,
): string {
  const entry = HTTP_RUNTIME_MODULES[module];
  const base = ctx.httpRuntimeImport;
  if (base === undefined || trimTrailingSlash(base) === HTTP_RUNTIME_PACKAGE) {
    return `${HTTP_RUNTIME_PACKAGE}/${entry.subpath}`;
  }
  const spec = `${trimTrailingSlash(base)}/${entry.file}`;
  if (base.startsWith("./") || base.startsWith("../")) {
    return relativeModuleSpecifier(ctx.outputLayout, pkg, spec, ctx.extStyle);
  }
  // A path alias onto a copied tree: file-precise like the relative form. An alias is
  // resolved by the adopter's own tsconfig `paths`, so the extension rule is theirs too.
  return ctx.extStyle === "js" ? `${spec}.js` : spec;
}

/**
 * The `httpRuntimeImport` that points a target's output at a copied tree: the path from
 * the target's output root to `<projectRoot>/<runtimeDir>`, relative, POSIX-separated.
 *
 * Relative rather than absolute so the emitted imports are the same on every machine,
 * and computed from the two directories rather than configured, so moving `outDir`
 * moves the imports with it. `meta verify --codegen` regenerates into a temp tree that
 * mirrors each outDir at its project-relative path, so the path it computes there is
 * the same one `meta gen` computed.
 */
export function ownedRuntimeImport(
  projectRoot: string,
  outDir: string,
  runtimeDir: string = OWNED_RUNTIME_DIR,
): string {
  const outAbs = isAbsolute(outDir) ? outDir : resolve(projectRoot, outDir);
  const runtimeAbs = isAbsolute(runtimeDir) ? runtimeDir : resolve(projectRoot, runtimeDir);
  const rel = relative(outAbs, runtimeAbs).split(sep).join("/");
  if (rel === "") return "./";
  return rel.startsWith("../") ? rel : `./${rel}`;
}
