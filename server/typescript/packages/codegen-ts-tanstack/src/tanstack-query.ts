import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, entityMetaFileName, renderEntityMetaFile, servesReadApi, isTphSubtype,
  withClientDirective, namesRef, namesConstArg,
} from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "./templates/hooks-file.js";

export interface TanstackQueryOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity generator that emits <Entity>.hooks.ts — a query-key factory
 * plus 2 query hooks and 3 mutation hooks backed by useEntityFetcher().
 *
 * If the user supplies their own filter, it AND-composes with the built-in gates.
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const tanstackQuery = function tanstackQuery(opts?: TanstackQueryOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "tanstack-query",
    // AND-composes the framework instance-artifact guard (skips abstract types —
    // they contribute shape via inheritance only and have no instance to query)
    // with the optional user filter. Projections still pass here and get read-only
    // hooks via renderHooksFile's isProjection branch.
    // FR-017 Tier 3: TPH subtypes get no standalone hooks file — their per-subtype
    // hooks live in the discriminator base's hooks file (polymorphic + per-subtype).
    filter: (e: MetaObject) => servesReadApi(e) && !isTphSubtype(e) && userFilter(e),
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
      //
      // §A6/§B2 — same `namesRef` pair every other §A6 site builds, scoped to THIS
      // generator's own render context: `.meta.ts` is a UI-generator artifact that can
      // sit on a DIFFERENT target from `namesFile()` (unlike the entity module, which
      // shares a target with names by construction — see names-file.ts).
      // `ctx.renderContext.includeNames` is already computed per-target by the runner,
      // so it is false here whenever the names artifact does not land in THIS
      // generator's own target — no separate check needed.
      const rc = ctx.renderContext;
      const metaNames = namesRef(entity, rc);
      const metaFile = {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package,
          entityMetaFileName(entity.name)),
        content: await formatTs(renderEntityMetaFile(
          entity,
          ctx.renderContext.apiPrefix,
          namesConstArg(metaNames),
        )),
      };
      return [metaFile, {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.hooks.ts`),
        // Outside formatTs deliberately: the directive must stay the module's first
        // token, and a formatter is entitled to move a leading string expression.
        content: withClientDirective(
          await formatTs(renderHooksFile(entity, ctx.renderContext)),
          ctx.renderContext.clientDirective,
        ),
      }];
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackQueryOpts | void>;
