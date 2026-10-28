// The repo's OWN copies of the ADR-0034 reference templates — what `meta eject` writes
// into a consumer's `codegen/generators/*.ts`. They date from 1.0, which removed
// `entityFile` / `queriesFile` / `routesFile` / `barrel` from
// `@metaobjectsdev/codegen-ts/generators`; 1.1 restored that import (ADR-0034 Amendment 5),
// and these stay because the owned path is still supported and still needs exercising.
// Taking the OWNED copies means this repo's suites run the artifact an adopter who ejects
// actually runs.
//
// The copies, with the template modules beside them in `src/templates/`, are byte-gated against
// what `meta eject` writes (the generator and its template closure) by
// `server/typescript/packages/cli/test/owned-copies-current.test.ts`, so they cannot drift from
// what an adopter is handed. Refresh with:
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
import { entityFile as ownedEntityFile, type EntityFileOpts } from "./generators/entity.js";
import { routesFile as ownedRoutesFile, type RoutesFileOpts } from "./generators/routes.js";

export type { EntityFileOpts, RoutesFileOpts };
export { queriesFile, type QueriesFileOpts } from "./generators/queries.js";
export { barrel, type BarrelOpts } from "./generators/barrel.js";

/** The owned entity generator, with its allowlist types imported from the package. */
export function entityFile(opts?: EntityFileOpts): Generator {
  return ownedEntityFile({ runtimeImport: HTTP_RUNTIME_PACKAGE, ...opts });
}

/** The owned Fastify routes generator, with its mount helpers imported from the package. */
export function routesFile(opts?: RoutesFileOpts): Generator {
  return ownedRoutesFile({ runtimeImport: HTTP_RUNTIME_PACKAGE, ...opts });
}

export { reportExport, type ReportExportOpts } from "./generators/report-export.js";
