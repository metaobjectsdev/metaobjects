// FrameworkTemplateProvider — resolves template refs (e.g. "docs/entity-page.md")
// against the codegen-ts package's `templates/` directory. Adopters who want
// to override a framework template create their own `templates/<ref>.mustache`
// file in their project; `ProviderChain` (below) consults the project first
// and falls back to the framework defaults.
//
// Decision D1 from the template-driven-codegen design — hybrid: framework
// ships defaults, adopters override by file-system convention.
//
// The framework Provider is filesystem-backed so it works identically whether
// codegen-ts runs from source (bun, dev) or from `dist/` (npm install). The
// `templates/` directory is included in the published tarball via
// package.json `files: ["dist", "src", "templates", ...]`.

import type { Provider } from "@metaobjectsdev/render";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Canonical shipped template — used to verify a candidate framework
 *  templates directory actually contains our defaults. Without this check a
 *  hoisted-install layout (pnpm/bun workspaces) can walk up to a CONSUMER
 *  package.json and silently return a templates dir that doesn't exist. */
const CANONICAL_TEMPLATE_REL = "docs/entity-page.md.mustache";

/** Walk up from `start` until we find a `package.json` whose neighbour
 *  `templates/` directory contains our canonical shipped template (i.e., the
 *  codegen-ts package root). Works the same way from
 *  `src/render-engine/framework-provider.ts` (during dev) and
 *  `dist/render-engine/framework-provider.js` (after `npm install`).
 *
 *  Returns `undefined` when no on-disk templates dir can be found — e.g. inside
 *  the `bun build --compile` standalone binary, whose `import.meta.url` is a
 *  `/$bunfs/root` virtual path with no real `package.json` alongside it. The
 *  embedded-template fallback (see `FileSystemProvider`) covers that case. */
function findFrameworkTemplatesDir(start: string): string | undefined {
  let dir = start;
  while (true) {
    const pkgJson = join(dir, "package.json");
    if (existsSync(pkgJson)) {
      const templatesDir = join(dir, "templates");
      // Assert we landed at the codegen-ts package root, not a consumer's.
      if (existsSync(join(templatesDir, CANONICAL_TEMPLATE_REL))) {
        return templatesDir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// In ESM (CLAUDE.md: "ESM only. No CommonJS."), `import.meta.url` is
// guaranteed to be a file: URL; no defensive try/catch needed.
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

// Lazy + cached: resolving the on-disk templates dir walks the filesystem, and
// in the standalone binary it never finds one (the embedded fallback handles
// it). Deferring the walk keeps merely *importing* this module side-effect-free
// — critical for the compiled `meta` binary, where eager resolution at import
// time used to throw before any command (even `--help`) could run.
let _frameworkTemplatesDir: string | null | undefined;
function frameworkTemplatesDir(): string | undefined {
  if (_frameworkTemplatesDir === undefined) {
    _frameworkTemplatesDir = findFrameworkTemplatesDir(SELF_DIR) ?? null;
  }
  return _frameworkTemplatesDir ?? undefined;
}

/** Provider backed by an arbitrary on-disk template directory. References
 *  resolve as `<dir>/<ref>.mustache`. Used by both the framework default
 *  and adopter override paths. */
export class FileSystemProvider implements Provider {
  constructor(private readonly root: string) {}
  resolve(ref: string): string | undefined {
    const path = join(this.root, `${ref}.mustache`);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  }
}

/** The framework defaults provider — resolves refs against codegen-ts's own
 *  on-disk `templates/` directory.
 *
 *  Resolution is lazy: the directory is located on first `resolve()`, not at
 *  module import. This keeps merely importing this module side-effect-free,
 *  which matters for the `bun build --compile` standalone `meta` binary — its
 *  `import.meta.url` is a `/$bunfs/root` virtual path with no on-disk
 *  `templates/` dir, so eager resolution at import time used to throw before
 *  any command (even `--help` or the schema ops `migrate`/`verify --db`) could
 *  run. Now non-codegen commands import cleanly; only the codegen doc path
 *  (which the standalone binary doesn't target) needs the on-disk dir. */
class FrameworkTemplatesProvider implements Provider {
  resolve(ref: string): string | undefined {
    const dir = frameworkTemplatesDir();
    if (dir === undefined) return undefined;
    const path = join(dir, `${ref}.mustache`);
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf-8");
  }
}

export const frameworkTemplatesProvider: Provider = new FrameworkTemplatesProvider();

/** Compose providers: first match wins. Adopters typically chain
 *  `[projectProvider, frameworkTemplatesProvider]` so their own templates
 *  override the framework defaults. */
export class ProviderChain implements Provider {
  constructor(private readonly providers: readonly Provider[]) {}
  resolve(ref: string): string | undefined {
    for (const p of this.providers) {
      const text = p.resolve(ref);
      if (text !== undefined) return text;
    }
    return undefined;
  }
}

/** Build a project-scoped Provider: layers an optional project `templates/`
 *  directory over the framework defaults. Returns just the framework provider
 *  when `projectRoot` is undefined / its `templates/` dir doesn't exist. */
export function projectProvider(projectRoot?: string): Provider {
  if (projectRoot === undefined) return frameworkTemplatesProvider;
  const projTemplates = resolve(projectRoot, "templates");
  if (!existsSync(projTemplates)) return frameworkTemplatesProvider;
  return new ProviderChain([
    new FileSystemProvider(projTemplates),
    frameworkTemplatesProvider,
  ]);
}

/** Exposed for tests that want to inspect the resolved framework templates
 *  directory (don't use outside tests). Resolved lazily so that merely
 *  importing this module never walks the filesystem or throws — tests always
 *  run from source where the on-disk dir exists; the standalone binary (where
 *  no dir exists) never touches this export. */
export function frameworkTemplatesDirForTests(): string {
  const dir = frameworkTemplatesDir();
  if (dir === undefined) {
    throw new Error("framework templates dir unresolved (test ran outside a source/install layout)");
  }
  return dir;
}
