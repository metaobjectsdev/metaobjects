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
export const REFERENCE_GENERATOR_NAMES = ["entity", "queries", "routes", "routes-hono", "barrel"] as const;
export type ReferenceGeneratorName = (typeof REFERENCE_GENERATOR_NAMES)[number];

/** A directory is a reference root iff it holds the first template the reader was told to expect. */
function isReferenceRoot(dir: string, sentinel: string): boolean {
  return existsSync(join(dir, `${sentinel}.ts`));
}

/**
 * FR-040 §4.1 — build a reference-template reader for ONE package. `moduleUrl` is the
 * calling module's `import.meta.url`, so each package resolves its OWN `src/reference/`.
 * `names[0]` is the sentinel that identifies the directory.
 *
 * Works in dev (module runs from `src/`, templates at `./reference/`) and in a published
 * install (module runs from `dist/`, templates at `../src/reference/`, since `src/` ships
 * alongside `dist/`). Walks up checking both layouts at each level.
 */
export function makeReferenceReader(moduleUrl: string, names: readonly [string, ...string[]]) {
  // A non-empty tuple type, so `names[0]` is `string` outright — this used to need a
  // runtime empty-check plus a re-bound const, because `noUncheckedIndexedAccess`
  // narrowing does not survive into the closures below. Every call site already passes
  // an `as const` tuple or an array literal, so the type costs nothing and deletes both.
  const sentinel: string = names[0];

  function resolveReferenceRoot(): string {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 8; i++) {
      for (const candidate of [join(dir, "reference"), join(dir, "src", "reference")]) {
        if (isReferenceRoot(candidate, sentinel)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      "reference templates not found — looked for `reference/` and `src/reference/` " +
        `walking up from ${dir}.`,
    );
  }

  return {
    resolveReferenceRoot,
    /**
     * Read one template by name. The name is checked against `names` FIRST: this is a
     * public export, so `name` is an untrusted `string` at runtime (the per-package
     * wrappers narrow to a literal union, but types are erased). Without the check it
     * interpolates straight into a path, so any caller threading a CLI argument through
     * reads whatever file the string points at. The allowlist is already a parameter —
     * enforcing it here makes the guarantee structural instead of something every call
     * site has to remember, and it is the reason `meta eject` needs no check of its own.
     */
    readReferenceTemplate: (name: string): string => {
      if (!names.includes(name)) {
        throw new Error(
          `unknown reference template "${name}". Available: ${names.join(", ")}.`,
        );
      }
      return readFileSync(join(resolveReferenceRoot(), `${name}.ts`), "utf8");
    },
  };
}

// This package's own reader — the back-compatible named exports `meta init` uses.
const ownReader = makeReferenceReader(import.meta.url, REFERENCE_GENERATOR_NAMES);

/** Resolve the `src/reference/` directory holding this package's reference generators. */
export function resolveReferenceRoot(): string {
  return ownReader.resolveReferenceRoot();
}

/** Read the raw source of one reference generator (e.g. `"entity"` → the text of `entity.ts`). */
export function readReferenceTemplate(name: ReferenceGeneratorName): string {
  return ownReader.readReferenceTemplate(name);
}
