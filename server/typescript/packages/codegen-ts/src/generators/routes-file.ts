import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFile } from "../templates/routes-file.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { hasAnyRdbSource } from "../source-detect.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
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
 * exports the entity-file generator never emits. Gated by `hasAnyRdbSource`.
 *
 * FR-017 Tier 2: TPH subtypes get no standalone routes file — their per-subtype
 * route set lives in the discriminator base's routes file.
 */
export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "routes-file",
    // Always set: AND-composes the built-in gates with the optional user filter.
    filter: (e: MetaObject) =>
      hasAnyRdbSource(e) && !isTphSubtype(e) && userFilter(e),
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
