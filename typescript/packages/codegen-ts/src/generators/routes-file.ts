import type { MetaModel } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderRoutesFile } from "../templates/routes-file.js";
import { formatTs } from "../format.js";

export interface RoutesFileOpts {
  filter?: (entity: MetaModel) => boolean;
}

/**
 * Per-entity opt-out via `@emitRoutes: false` is honored. If the user supplies
 * their own filter, both must pass (AND).
 */
export const routesFile = function routesFile(opts?: RoutesFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  return {
    name: "routes-file",
    // Always set: AND-composes metadata opt-out with optional user filter.
    filter: (e: MetaModel) => e.attr("emitRoutes") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("routes-file: renderContext is required (provided by runGen)");
      }
      return {
        path: `${entity.name}.routes.ts`,
        content: await formatTs(renderRoutesFile(entity, ctx.renderContext)),
      };
    }),
  };
} as GeneratorFactory<RoutesFileOpts | void>;
