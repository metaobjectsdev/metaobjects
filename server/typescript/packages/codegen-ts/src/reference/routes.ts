// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFile } from "./codegen/generators/routes.js";
//
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// use-when:      you want generated Fastify REST routes per entity. Drop it and hand-write routes
//                if you need bespoke endpoints — or keep it and add handlers via <Entity>.extra.ts.
// emits:         <target>/<Entity>.routes.ts — full CRUD for write-through entities, read-only
//                (GET list + GET :id) for projections, polymorphic + per-subtype for TPH bases.
//                Skipped for any sourceless object (incl. every object.value, source-less by
//                value purity) and for TPH subtypes — no source.rdb means no table/allowlist
//                for a routes file to import (#248 R2).
// customize:     this generator (filter, output path, per-entity @emitRoutes opt-out, target) is
//                YOURS — edit it freely. The route *composition* itself is richer than the others
//                (M:N junction traversal, TPH per-subtype route sets), so it stays in the engine via
//                `renderRoutesFile`. To own the composition too, copy `renderRoutesFile`'s body out
//                of the package source — it dispatches projection → mountReadOnlyCrudRoutes,
//                write-through → mountCrudRoutes (+ M:N mounts). For per-verb control, import the
//                mount* helpers from `@metaobjectsdev/runtime-ts/drizzle-fastify` and mix with your
//                own handlers (auth, side effects).
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.

import { type MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  renderRoutesFile,
  isTphSubtype,
  hasAnyRdbSource,
  formatTs,
  entityOutputPath,
  CODEGEN_ATTR_EMIT_ROUTES,
} from "@metaobjectsdev/codegen-ts";

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "routes-file",
    // per-entity opt-out via `@emitRoutes: false`; TPH subtypes get no standalone routes
    // file (their routes live in the discriminator base's); AND-composed with your filter.
    // #248 R2: an object with no declared/inherited source.rdb (of ANY kind) isn't
    // backed by any store — routes against it would import Drizzle table/allowlist
    // exports the entity file never emits. Gated by hasAnyRdbSource.
    filter: (e: MetaObject) =>
      // ADR-0039: resolving — a concrete entity may inherit its @emit* opt-out flag via extends.
      e.attr(CODEGEN_ATTR_EMIT_ROUTES) !== false && hasAnyRdbSource(e) && !isTphSubtype(e) && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("routes-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.routes.ts`),
        content: await formatTs(renderRoutesFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileOpts>;
