import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFileHono } from "../templates/routes-file-hono.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";
import { CODEGEN_ATTR_EMIT_ROUTES } from "../constants.js";

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
 */
export const routesFileHono = function routesFileHono(opts?: RoutesFileHonoOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "routes-file-hono",
    // Marks this as the Hono routes generator so the runner can aggregate
    // `ctx.config.includeHonoRoutes` and api-docs auto-documents the Hono surface.
    emitsHonoRoutes: true,
    filter: (e: MetaObject) => e.ownAttr(CODEGEN_ATTR_EMIT_ROUTES) !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
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
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileHonoOpts>;
