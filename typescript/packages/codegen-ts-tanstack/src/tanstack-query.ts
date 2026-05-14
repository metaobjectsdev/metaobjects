import type { MetaModel } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs } from "@metaobjects/codegen-ts";
import { renderHooksFile } from "./templates/hooks-file.js";

export interface TanstackQueryOpts {
  filter?: (entity: MetaModel) => boolean;
}

/**
 * Per-entity generator that emits <Entity>.hooks.ts — a query-key factory
 * plus 2 query hooks and 3 mutation hooks backed by useEntityFetcher().
 *
 * Per-entity opt-out via `@emitTanstack: false` is honored. If the user
 * supplies their own filter, both must pass (AND).
 */
export const tanstackQuery = function tanstackQuery(opts?: TanstackQueryOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  return {
    name: "tanstack-query",
    // AND-composes metadata opt-out with optional user filter.
    filter: (e: MetaModel) => e.attr("emitTanstack") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error(
          "tanstack-query: renderContext is required (provided by runGen)",
        );
      }
      return {
        path: `${entity.name}.hooks.ts`,
        content: await formatTs(renderHooksFile(entity, ctx.renderContext)),
      };
    }),
  };
} as GeneratorFactory<TanstackQueryOpts | void>;
