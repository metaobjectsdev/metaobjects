// Type provider model — provider-based, extensible metamodel registration.
//
// A MetaDataTypeProvider contributes (and/or extends) registered types. The
// contract is cross-language identical (Java MetaDataTypeProvider parity);
// discovery is per-language — for TS it is explicit composition via
// composeRegistry. See docs/superpowers/specs/2026-05-17-type-provider-model-design.md.

import { TypeRegistry } from "./registry.js";
import { MetaModelError } from "./errors.js";
import { mergeConstraints } from "./constraint-merge.js";
import { validateConstraints } from "./constraint-validate.js";

/** A unit of metamodel registration. One provider per package. */
export interface MetaDataTypeProvider {
  /** Stable id; other providers reference it in `dependencies`. */
  readonly id: string;
  /** Ids of providers that must register before this one. Default: none. */
  readonly dependencies?: readonly string[];
  /** Human/AI-facing description of what this provider contributes. */
  readonly description?: string;
  /** Register new types and/or extend existing ones. */
  registerTypes(registry: TypeRegistry): void;
}

/**
 * Build a TypeRegistry by composing providers. Providers are topologically
 * sorted by their `dependencies`; the sort is stable — providers with no
 * ordering constraint between them keep input order. Throws on a duplicate
 * provider id, a missing dependency, or a dependency cycle.
 */
export function composeRegistry(
  providers: readonly MetaDataTypeProvider[],
  opts?: { validate?: boolean },
): TypeRegistry {
  const ordered = topoSortProviders(providers);
  const registry = new TypeRegistry();
  for (const provider of ordered) {
    provider.registerTypes(registry);
  }
  // FR-033 — opt-in metamodel contradiction gate. The library bootstrap (the
  // loader's default registry) sets validate:true so a contradictory provider set
  // fails fast at bootstrap (mirrors ADR-0023 strictness). Off by default so
  // synthetic/partial registries (tests, incremental composition) are unaffected.
  if (opts?.validate === true) {
    const contradictions = validateConstraints(mergeConstraints(registry), registry);
    if (contradictions.length > 0) {
      throw new MetaModelError(
        `composeRegistry: the provider set has ${contradictions.length} metamodel ` +
          `constraint contradiction(s) (FR-033):\n` +
          contradictions.map((e) => `  - ${e.message}`).join("\n"),
        { code: "ERR_INVALID_METAMODEL_CONSTRAINT" },
      );
    }
  }
  return registry;
}

function topoSortProviders(
  providers: readonly MetaDataTypeProvider[],
): MetaDataTypeProvider[] {
  // Duplicate-id check.
  const ids = new Set<string>();
  for (const p of providers) {
    if (ids.has(p.id)) {
      throw new MetaModelError(`composeRegistry: duplicate provider id "${p.id}"`, { code: "ERR_PROVIDER_DUPLICATE_ID" });
    }
    ids.add(p.id);
  }
  // Missing-dependency check.
  for (const p of providers) {
    for (const dep of p.dependencies ?? []) {
      if (!ids.has(dep)) {
        throw new MetaModelError(
          `composeRegistry: provider "${p.id}" depends on "${dep}", which is not in the provider set`,
          { code: "ERR_PROVIDER_MISSING_DEPENDENCY" },
        );
      }
    }
  }
  // Stable topological sort: repeatedly emit the first (input-order) provider
  // whose dependencies are all already emitted. O(n^2) — n is a handful.
  const result: MetaDataTypeProvider[] = [];
  const emitted = new Set<string>();
  while (result.length < providers.length) {
    const next = providers.find(
      (p) =>
        !emitted.has(p.id) &&
        (p.dependencies ?? []).every((d) => emitted.has(d)),
    );
    if (next === undefined) {
      const stuck = providers
        .filter((p) => !emitted.has(p.id))
        .map((p) => p.id);
      throw new MetaModelError(
        `composeRegistry: dependency cycle among providers [${stuck.join(", ")}]`,
        { code: "ERR_PROVIDER_DEPENDENCY_CYCLE" },
      );
    }
    result.push(next);
    emitted.add(next.id);
  }
  return result;
}
