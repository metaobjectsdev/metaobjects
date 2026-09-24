import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFile } from "../templates/routes-file.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { servesReadApi } from "../api-surface.js";
import { renderRoutesIndex, routesIndexFileName } from "../templates/routes-index.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";
import { resolveExpose, type ExposeOption } from "../routes-expose.js";
import { effectivePackage } from "../docs-paths.js";

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Which CRUD verbs the emitted file mounts (#348). Verbs, or a per-entity function;
   * absent means all five and emits byte-identical output.
   *
   *   routesFile({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
   *
   * A `filter` cannot express this — it decides whether the file emits AT ALL, so it can
   * only remove the whole surface, not restrict it to a subset of verbs.
   */
  expose?: ExposeOption;
  /**
   * Also emit `routes.index.ts` at the target root: one `registerAllRoutes(...)` that registers every
   * entity this generator emitted a routes file for, so adding an entity needs no edit to
   * your host file. Off by default, so a project that does not ask gets no new file.
   */
  registerAll?: boolean;
  target?: string;
}

/**
 * If the user supplies their own filter, it AND-composes with the built-in gates.
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 *
 * #248 R2: an object with no declared/inherited source.rdb (of ANY kind) isn't
 * backed by any store — routes against it would import Drizzle table/allowlist
 * exports the entity-file generator never emits. Gated by `servesReadApi`, which also
 * excludes abstract objects: an abstract level has no table of its own to mount.
 *
 * FR-017 Tier 2: TPH subtypes get no standalone routes file — their per-subtype
 * route set lives in the discriminator base's routes file.
 */
export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const emitEntities = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("routes-file: renderContext is required (provided by runGen)");
    }
    return {
      path: entityOutputPath(ctx.config.outputLayout ?? "flat", effectivePackage(entity), `${entity.name}.routes.ts`),
      content: await formatTs(renderRoutesFile(entity, ctx.renderContext, resolveExpose(entity, opts?.expose))),
    };
  });
  const generator: Generator = {
    name: "routes-file",
    // Always set: AND-composes the built-in gates with the optional user filter.
    filter: (e: MetaObject) =>
      servesReadApi(e) && !isTphSubtype(e) && userFilter(e),
    generate: async (ctx) => {
      const files = await emitEntities(ctx);
      if (!opts?.registerAll) return files;
      const matched = ctx.entities.filter(ctx.matches);
      if (matched.length === 0 || !ctx.renderContext) return files;
      return [...files, {
        path: routesIndexFileName("fastify"),
        content: await formatTs(renderRoutesIndex(matched, ctx.renderContext, "fastify")),
      }];
    },
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<RoutesFileOpts>;
