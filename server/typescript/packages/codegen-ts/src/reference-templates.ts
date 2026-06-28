// ADR-0034 scaffold-and-own — locate + read the copyable reference generators that
// live (as raw source assets) in `src/reference/*.ts`. `meta init` reads them through
// here and writes them into the consumer's repo (e.g. `codegen/generators/*.ts`), which
// the consumer then OWNS. The templates import only `@metaobjectsdev/codegen-ts` (the
// stable engine), so a copied file works verbatim with no rewriting.
//
// The reference files are excluded from the tsc build (they are scaffold assets, not
// package source — see tsconfig.json). They ship to npm via the package `files: ["src"]`
// entry, so they are present at `<pkg>/src/reference/*.ts` in a published install.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Basenames (no extension) of the copyable reference generators shipped in `src/reference/`. */
export const REFERENCE_GENERATOR_NAMES = ["entity", "queries", "routes", "barrel"] as const;
export type ReferenceGeneratorName = (typeof REFERENCE_GENERATOR_NAMES)[number];

/** A directory is the reference root iff it holds the entity reference template. */
function isReferenceRoot(dir: string): boolean {
  return existsSync(join(dir, "entity.ts"));
}

/**
 * Resolve the `src/reference/` directory holding the copyable reference generators.
 * Works in dev (this module runs from `src/`, templates at `./reference/`) and in a
 * published install (this module runs from `dist/`, templates at `../src/reference/`,
 * since `src/` ships alongside `dist/`). Walks up checking both layouts at each level.
 */
export function resolveReferenceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    for (const candidate of [join(dir, "reference"), join(dir, "src", "reference")]) {
      if (isReferenceRoot(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "codegen-ts reference templates not found — looked for `reference/` and `src/reference/` " +
      "walking up from the codegen-ts module.",
  );
}

/** Read the raw source of one reference generator (e.g. `"entity"` → the text of `entity.ts`). */
export function readReferenceTemplate(name: ReferenceGeneratorName): string {
  return readFileSync(join(resolveReferenceRoot(), `${name}.ts`), "utf8");
}
