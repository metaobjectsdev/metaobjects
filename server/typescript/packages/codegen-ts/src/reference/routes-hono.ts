// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes-hono.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFileHono } from "./codegen/generators/routes-hono.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`.
// targets:       Hono. The emitted file imports `mountCrudRoutes` from
//                `@metaobjectsdev/runtime-ts/hono` and takes its persistence client as
//                INJECTED DEPS (`register<Entity>Routes(app, { db })`) rather than a
//                module-singleton import — which is what makes it portable to any host
//                that can hand Hono a request. If your framework is not Hono, THIS is the
//                file to retarget: swap the mount helper and the exported signature; the
//                metadata walk above it is framework-neutral and stays as-is.
// use-when:      you want generated Hono CRUD routes per entity.
// emits:         <target>/<Entity>.routes.hono.ts — full CRUD for write-through entities,
//                read-only (GET list + GET :id) for projections. Skipped for any sourceless
//                object and for TPH subtypes.
// customize:     this generator is YOURS — edit it freely. For the emitted route
//                composition, call `renderRoutesFileHono` (exported from the engine) and
//                wrap its result, or replace the call entirely. Decide per generator what
//                you consume: wire only the generators whose output you actually import,
//                and narrow this one with its `filter`. There is no `@emit*` metadata
//                attribute — those were never registered vocabulary, so `meta verify`
//                rejects them (ERR_UNKNOWN_ATTR).
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.

import { type MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  renderRoutesFileHono,
  resolveExpose,
  type ExposeOption,
  isTphSubtype,
  hasAnyRdbSource,
  formatTs,
  entityOutputPath,
} from "@metaobjectsdev/codegen-ts";

export interface RoutesFileHonoOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Which CRUD verbs the emitted file mounts (#348). Verbs, or a per-entity function;
   * absent means all five and emits byte-identical output.
   *
   *   routesFileHono({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
   *
   * A `filter` cannot express this — it decides whether the file emits AT ALL, so it can
   * only remove the whole surface, not restrict it to a subset of verbs.
   */
  expose?: ExposeOption;
  target?: string;
}

export const routesFileHono = function routesFileHono(opts?: RoutesFileHonoOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Eligibility, minus the TPH question — stated ONCE so the emit set and the warn set
  // below cannot drift apart. They differ only by `!isTphSubtype` vs `isTphSubtype`, and
  // written out twice a later edit to one silently makes an entity either stop emitting
  // without being named as held back, or get warned about while still emitting.
  // (Same shape as tanstack's grid generator, which factors it the same way.)
  const passesOtherGates = (e: MetaObject): boolean =>
    hasAnyRdbSource(e) && userFilter(e);
  const generator: Generator = {
    name: "routes-file-hono",
    // Marks this as the Hono routes generator so the runner can aggregate
    // `ctx.config.includeHonoRoutes` and api-docs auto-documents the Hono surface.
    emitsHonoRoutes: true,
    // TPH subtypes are EXCLUDED, matching the Fastify generator. A TPH subtype shares
    // its base's table, so mounting vanilla CRUD for it produced routes with no
    // discriminator scoping at all: the list returned EVERY subtype's rows, and
    // get/patch/delete by id happily operated on rows belonging to a different
    // subtype. Silently wrong data, which is worse than no route. Fastify dispatches
    // these to a discriminator-aware renderer; the Hono runtime has no discriminator
    // support yet, so this fails CLOSED and the run says so (see the warning below)
    // rather than shipping an artifact that returns the wrong rows.
    filter: (e: MetaObject) => passesOtherGates(e) && !isTphSubtype(e),
    generate: async (ctx) => {
      // One note per run naming every TPH subtype held back, so the gap is visible at
      // `meta gen` time rather than discovered as missing endpoints in production.
      const skipped = ctx.entities.filter((e) => passesOtherGates(e) && isTphSubtype(e));
      if (skipped.length > 0) {
        ctx.warn(
          `no Hono routes emitted for the TPH subtype(s) ${skipped.map((e) => e.name).join(", ")} — ` +
          "the Hono adapter has no discriminator scoping yet, so per-subtype CRUD would " +
          "return and mutate OTHER subtypes' rows. Use routesFile() (Fastify), which " +
          "dispatches TPH correctly, or hand-write the scoped routes.",
        );
      }
      return emit(ctx);
    },
  };
  const emit = perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("routes-file-hono: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(
          ctx.config.outputLayout ?? "flat",
          entity.package,
          `${entity.name}.routes.hono.ts`,
        ),
        content: await formatTs(renderRoutesFileHono(entity, ctx.renderContext, resolveExpose(entity, opts?.expose))),
      };
  });
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileHonoOpts>;
