// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/hooks.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { tanstackQuery } from "./codegen/generators/hooks.js";
//
// RUNTIME: this file executes under whatever runs `meta gen` — NODE, even in a Bun
// project. Do not reach for `Bun.*` globals here.
// targets:       TanStack Query. The emitted hooks call `useEntityFetcher()` from
//                `@metaobjectsdev/tanstack`, so the module is a CLIENT component.
//                If your framework compiles server and client from one tree and resolves
//                each half under different conditions, the emitted file may need a marker
//                directive — prepend it to `renderHooksFile`'s result below. That is a
//                one-line change in THIS file and is the intended way to do it.
// use-when:      you want a query-key factory plus 2 query hooks and 3 mutation hooks,
//                backed by TanStack Query, per entity.
// emits:         <target>/<Entity>.hooks.ts, plus the DB-free <Entity>.meta.ts descriptor
//                the hooks module imports from. Emissions byte-identical to another UI
//                generator's copy of the same descriptor collapse to one file (#266).
// customize:     this generator is YOURS. `renderHooksFile` (exported from
//                @metaobjectsdev/codegen-ts-tanstack) produces the hooks body — wrap it,
//                prepend to it, or replace the call entirely with your own renderer.
// composes-with: entity.ts (imports the table/schemas these hooks fetch/validate against).

import { type MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  entityMetaFileName,
  renderEntityMetaFile,
  servesReadApi,
  isTphSubtype,
 
  withClientDirective,
  resolveObjectNames,
  siblingSpecifier,
  code,
  imp,
  type Code,
} from "@metaobjectsdev/codegen-ts";
import { renderHooksFile } from "@metaobjectsdev/codegen-ts-tanstack";

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
      // §A6 fix round 3 — same resolveObjectNames + imp(...) pair every other §A6
      // site builds, scoped to THIS generator's own render context: `.meta.ts` is a
      // UI-generator artifact that can sit on a DIFFERENT target from `namesFile()`
      // (unlike the entity module, which shares a target with names by construction
      // — see names-file.ts). `ctx.renderContext.includeNames` is already computed
      // per-target by the runner, so it is false here whenever the names artifact
      // does not land in THIS generator's own target — no separate check needed.
      const rc = ctx.renderContext;
      const metaNames = rc.includeNames ? resolveObjectNames(entity, rc.columnNamingStrategy) : undefined;
      const metaNamesSym: Code | undefined =
        metaNames === undefined
          ? undefined
          : code`${imp(`${entity.name}Names@${siblingSpecifier(rc.selfTarget, entity.package, `${entity.name}.names`, rc.extStyle)}`)}`;
      const metaFile = {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package,
          entityMetaFileName(entity.name)),
        content: await formatTs(renderEntityMetaFile(
          entity,
          ctx.renderContext.apiPrefix,
          metaNames !== undefined && metaNamesSym !== undefined
            ? { name: metaNames.name, symbol: metaNamesSym }
            : undefined,
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
