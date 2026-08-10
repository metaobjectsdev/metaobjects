import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, entityMetaFileName, renderEntityMetaFile, servesReadApi, isTphSubtype, CODEGEN_ATTR_EMIT_TANSTACK } from "@metaobjectsdev/codegen-ts";
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
    // AND-composes the framework instance-artifact guard (skips abstract types —
    // they contribute shape via inheritance only and have no instance to query),
    // the metadata opt-out, and the optional user filter. Projections still pass
    // here and get read-only hooks via renderHooksFile's isProjection branch.
    // FR-017 Tier 3: TPH subtypes get no standalone hooks file — their per-subtype
    // hooks live in the discriminator base's hooks file (polymorphic + per-subtype).
    // ADR-0039: resolving — a concrete entity may inherit @emitTanstack via extends.
    filter: (e: MetaObject) => servesReadApi(e) && e.attr(CODEGEN_ATTR_EMIT_TANSTACK) !== false && !isTphSubtype(e) && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error(
          "tanstack-query: renderContext is required (provided by runGen)",
        );
      }      // Also emit the DB-free descriptor module this file imports from. Each UI
      // generator emits it rather than relying on the consumer wiring an extra
      // generator: the entity generator is scaffold-and-own (ADR-0034), so it cannot
      // be changed from the package. Emissions are byte-identical between generators,
      // which the runner collapses (#266).
      const metaFile = {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package,
          entityMetaFileName(entity.name)),
        content: await formatTs(renderEntityMetaFile(entity, ctx.renderContext.apiPrefix)),
      };
      return [metaFile, {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.hooks.ts`),
        content: await formatTs(renderHooksFile(entity, ctx.renderContext)),
      }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackQueryOpts | void>;
