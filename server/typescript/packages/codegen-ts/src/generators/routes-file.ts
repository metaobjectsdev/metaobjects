import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFile } from "../templates/routes-file.js";
import { isTphSubtype } from "../templates/zod-validators.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface RoutesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity opt-out via `@emitRoutes: false` is honored. If the user supplies
 * their own filter, both must pass (AND).
 *
 * FR-017 Tier 2: TPH subtypes get no standalone routes file — their per-subtype
 * route set lives in the discriminator base's routes file.
 */
export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "routes-file",
    // Always set: AND-composes metadata opt-out with optional user filter.
    filter: (e: MetaObject) =>
      e.ownAttr("emitRoutes") !== false && !isTphSubtype(e) && userFilter(e),
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
