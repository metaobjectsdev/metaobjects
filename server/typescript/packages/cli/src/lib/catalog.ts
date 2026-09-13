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

/** The slices, in install-boundary order: the engine, then its framework packages. */
const SLICES: ReadonlyArray<readonly [string, Record<string, GeneratorRegistryEntry>]> = [
  ["@metaobjectsdev/codegen-ts", generatorRegistry],
  ["@metaobjectsdev/codegen-ts-react", reactGeneratorRegistry],
  ["@metaobjectsdev/codegen-ts-tanstack", tanstackGeneratorRegistry],
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
 * The composed catalog, keyed by stable name.
 *
 * Throws on a name registered by two packages. A stable name identifies ONE generator
 * across the whole catalog — that is the entire content of ADR-0021 D3 — so a collision
 * is a build-time defect, not something to resolve by precedence. Silently letting the
 * last slice win would make `meta gen --list` describe one generator and `meta gen` run
 * another.
 */
export function composeCatalog(): Record<string, GeneratorRegistryEntry> {
  const out: Record<string, GeneratorRegistryEntry> = {};
  const from: Record<string, string> = {};
  for (const [pkg, slice] of SLICES) {
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
