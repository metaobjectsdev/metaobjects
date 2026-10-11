// The TypeScript port's generator CATALOG — the one place all three registry slices
// are visible at once (ADR-0021 D3; opt-in-codegen design §D2a).
//
// `codegen-ts` owns the entry type and its own entries, but cannot import
// `codegen-ts-react` / `codegen-ts-tanstack` (dependency direction), so each of those
// exports its own slice and the CLI unions them here — exactly how `eject.ts` already
// composes its `SOURCES` table over the same three packages.
//
// Before this existed, `meta gen --list` read the codegen-ts registry and
// `meta eject --list` read the reference-template lists, so an agent asking "what can I
// turn on" got two different answers. After it, they are one table with two views.
//
// (The Angular generators stay out until ADR-0048's promotion bar is met — a
// source-only package is not a catalog entry.)

import {
  generatorRegistry,
  GENERATOR_LAYERS,
  type GeneratorRegistryEntry,
} from "@metaobjectsdev/codegen-ts";
import { reactGeneratorRegistry } from "@metaobjectsdev/codegen-ts-react";
import { tanstackGeneratorRegistry } from "@metaobjectsdev/codegen-ts-tanstack";

/**
 * The engine package. Its factories are served from a `/generators` subpath rather than
 * its root (the root is the engine plus the primitives an owned generator composes); the
 * framework packages serve theirs from the root. Exported because `eject.ts`'s source
 * table names the same package — one definition per CLI package, not two.
 */
export const CORE_CODEGEN_PACKAGE = "@metaobjectsdev/codegen-ts";

/**
 * The slices, in install-boundary order: the engine, then its framework packages. The
 * third element is the module that package serves factories from — a per-package fact
 * declared at registration, so {@link factoryModuleOf} is a lookup and a new slice
 * carries its own fact instead of adding a case to a name-keyed branch.
 */
const SLICES: ReadonlyArray<readonly [string, Record<string, GeneratorRegistryEntry>, string]> = [
  [CORE_CODEGEN_PACKAGE, generatorRegistry, `${CORE_CODEGEN_PACKAGE}/generators`],
  ["@metaobjectsdev/codegen-ts-react", reactGeneratorRegistry, "@metaobjectsdev/codegen-ts-react"],
  ["@metaobjectsdev/codegen-ts-tanstack", tanstackGeneratorRegistry, "@metaobjectsdev/codegen-ts-tanstack"],
];

/**
 * Which npm package a catalog entry comes from.
 *
 * This is the fact composition ADDS: a slice cannot know its own package name without
 * hard-coding it in every entry, and the package is precisely what `meta eject` has to
 * name in an install command. Undefined for a name no slice registers.
 */
export function packageOf(name: string): string | undefined {
  return SLICES.find(([, slice]) => name in slice)?.[0];
}

/** Every `@metaobjectsdev` package that contributes catalog entries. */
export function catalogPackages(): string[] {
  return SLICES.map(([pkg]) => pkg);
}

/**
 * The module a catalog entry's factory is imported from to run it as shipped — the third
 * element of the slice that registers the name. Undefined for a name no slice registers.
 */
export function factoryModuleOf(name: string): string | undefined {
  return SLICES.find(([, slice]) => name in slice)?.[2];
}

/**
 * How one generator reaches a config as shipped: the import line for its factory. The
 * call is not derived here — a factory's options are documented with the generator.
 */
export interface GeneratorWiring {
  import: string;
}

/**
 * How to wire a catalog entry AS SHIPPED: import its factory from the package, no copy.
 *
 * This is the half of "import by default, eject to customize" the catalog owns. The
 * other half is `meta eject`, which prints the import for the owned copy — the symbol is
 * the same in both (gated), so moving between them is one import line.
 *
 * Undefined for an entry `meta docs` runs (one that carries `docsSurface`): that command
 * is its door, and `meta gen` skips it in `generators: [...]`, so an import line for that
 * array would be an instruction to wire something the run ignores. Asked of the marker
 * and not of `layer`: the layer is how the listing is grouped, and a docs-layer generator
 * that `meta gen` does run would need its import like any other.
 */
export function packagedWiring(entry: GeneratorRegistryEntry): GeneratorWiring | undefined {
  if (entry.docsSurface !== undefined) return undefined;
  const from = factoryModuleOf(entry.name);
  if (from === undefined) return undefined;
  return { import: `import { ${entry.factoryExport} } from "${from}";` };
}

/**
 * The composed catalog, keyed by stable name.
 *
 * Throws on a name registered by two packages. A stable name identifies ONE generator
 * across the whole catalog — that is the entire content of ADR-0021 D3 — so a collision
 * is a build-time defect, not something to resolve by precedence. Silently letting the
 * last slice win would make `meta gen --list` describe one generator and `meta gen` run
 * another.
 */
export function composeCatalog(): Record<string, GeneratorRegistryEntry> {
  return composeSlices(SLICES.map(([pkg, slice]) => [pkg, slice] as const));
}

/**
 * The composition itself, over any slice list.
 *
 * Separate from {@link composeCatalog} so the REFUSAL is reachable from a test. With the
 * live `SLICES` closed over, the only thing a test could assert is that today's three
 * packages happen not to collide — which stays true if the check above is deleted, so
 * the guard that makes a collision a build failure was never covered by anything.
 */
export function composeSlices(
  slices: ReadonlyArray<readonly [string, Record<string, GeneratorRegistryEntry>]>,
): Record<string, GeneratorRegistryEntry> {
  const out: Record<string, GeneratorRegistryEntry> = {};
  const from: Record<string, string> = {};
  for (const [pkg, slice] of slices) {
    for (const [name, entry] of Object.entries(slice)) {
      if (name in out) {
        throw new Error(
          `generator "${name}" is registered by both ${from[name]} and ${pkg} — a stable ` +
            "name identifies ONE generator across the whole catalog (ADR-0021 D3). Rename " +
            "one of them, or delete the duplicate registration.",
        );
      }
      out[name] = entry;
      from[name] = pkg;
    }
  }
  return out;
}

/**
 * Every catalog entry, grouped by layer in {@link GENERATOR_LAYERS} order and
 * alphabetical within a layer.
 *
 * Layer order, not tier order: `layer` is the axis an adopter selects by, so it is the
 * axis the listing is organized along. `tier` still travels on each row.
 */
export function listCatalog(): GeneratorRegistryEntry[] {
  return Object.values(composeCatalog()).sort(
    (a, b) =>
      GENERATOR_LAYERS.indexOf(a.layer) - GENERATOR_LAYERS.indexOf(b.layer) ||
      a.name.localeCompare(b.name),
  );
}

/** Resolve one catalog entry by stable name, or undefined. */
export function catalogEntry(name: string): GeneratorRegistryEntry | undefined {
  return composeCatalog()[name];
}
