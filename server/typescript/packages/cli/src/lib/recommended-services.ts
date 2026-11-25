// recommended-services.ts — the one list MetaObjects recommends for the TypeScript service layers
// (ADR-0067 §5.1): the names, the contract types, data access, the service and its transport.
//
// It is documentation and what `meta init --with-services` writes (§8), never a mode: an app adds,
// removes, configures or replaces an entry the way it does any other. Defined once here, so the
// scaffold and the catalog's text view name the same list; each import is read from the shared
// generator registry rather than restated.

import { getGenerator, type GeneratorRegistryEntry } from "@metaobjectsdev/codegen-ts";

/** The stable names, in the order the scaffold lists them. */
export const RECOMMENDED_SERVICE_GENERATORS = [
  "entity",
  "rules-names",
  "contract-types",
  "service",
  "service-routes",
] as const;

/** Where every recommended factory is imported from. */
export const RECOMMENDED_SERVICE_IMPORT = "@metaobjectsdev/codegen-ts/generators";

/** The registry entries of the recommended list; throws if one is missing (a registry rename). */
export function recommendedServiceEntries(): GeneratorRegistryEntry[] {
  return RECOMMENDED_SERVICE_GENERATORS.map((name) => {
    const entry = getGenerator(name);
    if (entry === undefined) throw new Error(`recommended service generator "${name}" is not in the generator registry`);
    return entry;
  });
}

/**
 * The factory calls the scaffold writes. Cloudflare D1 holds no transaction across application
 * code (ADR-0067 §4), so on D1 the service is generated without one.
 */
export function recommendedServiceCalls(opts: { interactiveTransactions: boolean }): string[] {
  return recommendedServiceEntries().map((e) =>
    e.name === "service" && !opts.interactiveTransactions
      ? `${e.factoryExport}({ interactiveTransactions: false })`
      : `${e.factoryExport}()`,
  );
}

/** The list as prose, for a comment or a message: "entityFile(), …, and serviceRoutesFile()". */
export function recommendedServiceListText(): string {
  const calls = recommendedServiceEntries().map((e) => `${e.factoryExport}()`);
  return `${calls.slice(0, -1).join(", ")} and ${calls[calls.length - 1]}`;
}
