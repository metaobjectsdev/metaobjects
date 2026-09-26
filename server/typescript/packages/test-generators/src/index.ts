// The repo's OWN copies of the ADR-0034 reference templates — the same move `meta init`
// scaffolds into a consumer's `codegen/generators/*.ts`. They exist because 1.0 removes
// `entityFile` / `queriesFile` / `routesFile` / `barrel` from
// `@metaobjectsdev/codegen-ts/generators` (readiness G2, ADR-0035 A3), and the suites that
// drive `runGen` need a generator set. Taking the OWNED copies rather than reaching for an
// engine internal means this repo's tests exercise the artifact an adopter actually runs.
//
// The copies are byte-gated against `readReferenceTemplate()` by `test/owned-copies-current.test.ts`,
// so they cannot drift from the templates `meta init` ships. Refresh with:
//   bun scripts/sync-owned-template-copies.ts
//
// ONE deliberate difference from an adopter's wiring, made here and not in the copies: an
// ejected `entity` / `routes` points its output at the HTTP-adapter SOURCE `meta eject`
// copies into `codegen/runtime/` (ADR-0034 Amendment 3, 2026-09-24). The suites that use
// this package have no such copy — they boot the generated routes against THIS
// workspace's `@metaobjectsdev/runtime-ts`, which is what they are testing — so the two
// generators that import that tier are bound to the package here, through the option the
// reference exposes for exactly that choice. The eject path itself is gated by the CLI's
// own tests, which do copy the adapter.
//
// This package is `private: true` and is never published.
import { HTTP_RUNTIME_PACKAGE, type Generator } from "@metaobjectsdev/codegen-ts";
import { entityFile as ownedEntityFile, type EntityFileOpts } from "./entity.js";
import { routesFile as ownedRoutesFile, type RoutesFileOpts } from "./routes.js";

export type { EntityFileOpts, RoutesFileOpts };
export { queriesFile, type QueriesFileOpts } from "./queries.js";
export { barrel, type BarrelOpts } from "./barrel.js";

/** The owned entity generator, with its allowlist types imported from the package. */
export function entityFile(opts?: EntityFileOpts): Generator {
  return ownedEntityFile({ runtimeImport: HTTP_RUNTIME_PACKAGE, ...opts });
}

/** The owned Fastify routes generator, with its mount helpers imported from the package. */
export function routesFile(opts?: RoutesFileOpts): Generator {
  return ownedRoutesFile({ runtimeImport: HTTP_RUNTIME_PACKAGE, ...opts });
}
