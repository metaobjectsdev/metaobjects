import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath } from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "./templates/hooks-file.js";

export interface TanstackQueryOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
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
  const generator: Generator = {
    name: "tanstack-query",
    // AND-composes metadata opt-out with optional user filter.
    filter: (e: MetaObject) => e.ownAttr("emitTanstack") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error(
          "tanstack-query: renderContext is required (provided by runGen)",
        );
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.hooks.ts`),
        content: await formatTs(renderHooksFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackQueryOpts | void>;
