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
 *  `dist/render-engine/framework-provider.js` (after `npm install`). */
function findFrameworkTemplatesDir(start: string): string {
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
  throw new Error(
    `framework templates dir unresolved: walked up from ${start} without finding a package.json ` +
    `whose templates/${CANONICAL_TEMPLATE_REL} exists. This usually means codegen-ts was installed ` +
    `via a hoisted layout (pnpm/bun workspaces) into an unexpected location, or the published ` +
    `tarball is missing the templates/ directory.`,
  );
}

// In ESM (CLAUDE.md: "ESM only. No CommonJS."), `import.meta.url` is
// guaranteed to be a file: URL; no defensive try/catch needed.
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

const FRAMEWORK_TEMPLATES_DIR = findFrameworkTemplatesDir(SELF_DIR);

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
 *  `templates/` directory. */
export const frameworkTemplatesProvider: Provider = new FileSystemProvider(
  FRAMEWORK_TEMPLATES_DIR,
);

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

/** Exposed for tests that want to inspect / clear the resolved framework
 *  templates directory (don't use outside tests). */
export const __frameworkTemplatesDirForTests = FRAMEWORK_TEMPLATES_DIR;
