import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFileHono } from "../templates/routes-file-hono.js";
import { hasAnyRdbSource } from "../source-detect.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";
import { CODEGEN_ATTR_EMIT_ROUTES } from "../constants.js";
import { isTphSubtype } from "../templates/zod-validators.js";

export interface RoutesFileHonoOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Hono variant of routesFile() — emits `<Entity>.routes.hono.ts` mounting
 * the same five CRUD verbs (GET list / GET :id / POST / PATCH+PUT / DELETE)
 * against `@metaobjectsdev/runtime-ts/hono` rather than `…/drizzle-fastify`.
 *
 * Same cross-port wire contract (envelope shape, status codes, filter +
 * sort + withCount semantics) as the Fastify flavor. Workers / Bun / Node
 * consumers running Hono can replace hand-written route registration with
 * this generator output one entity at a time.
 *
 * Per-entity opt-out via `@emitRoutes: false` is honored. If the user
 * supplies their own filter, both must pass (AND).
 *
 * #248 R2: an object with no declared/inherited source.rdb (of ANY kind) isn't
 * backed by any store — gated by `hasAnyRdbSource` (does NOT add TPH handling;
 * that gap is pre-existing and out of scope here).
 */
export const routesFileHono = function routesFileHono(opts?: RoutesFileHonoOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Eligibility, minus the TPH question — stated ONCE so the emit set and the warn set
  // below cannot drift apart. They differ only by `!isTphSubtype` vs `isTphSubtype`, and
  // written out twice a later edit to one silently makes an entity either stop emitting
  // without being named as held back, or get warned about while still emitting.
  const passesOtherGates = (e: MetaObject): boolean =>
    // ADR-0039: resolving — a concrete entity may inherit @emitRoutes via extends.
    e.attr(CODEGEN_ATTR_EMIT_ROUTES) !== false
    && hasAnyRdbSource(e)
    && userFilter(e);
  const generator: Generator = {
    name: "routes-file-hono",
    // Marks this as the Hono routes generator so the runner can aggregate
    // `ctx.config.includeHonoRoutes` and api-docs auto-documents the Hono surface.
    emitsHonoRoutes: true,
    // ADR-0039: resolving — a concrete entity may inherit @emitRoutes via extends.
    //
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
        content: await formatTs(renderRoutesFileHono(entity, ctx.renderContext)),
      };
  });
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileHonoOpts>;
