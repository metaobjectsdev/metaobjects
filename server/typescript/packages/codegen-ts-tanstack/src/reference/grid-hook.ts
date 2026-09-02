// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/grid-hook.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { tanstackGridHook } from "./codegen/generators/grid-hook.js";
//
// RUNTIME: this file executes under whatever runs `meta gen` — NODE, even in a Bun
// project. Do not reach for `Bun.*` globals here.
// targets:       TanStack Query. The emitted hook calls `useEntityFetcher()` from
//                `@metaobjectsdev/tanstack`, so the module is a CLIENT component.
//                If your framework compiles server and client from one tree and resolves
//                each half under different conditions, the emitted file may need a marker
//                directive — prepend it to `renderGridHookFile`'s result below. That is a
//                one-line change in THIS file and is the intended way to do it.
// use-when:      you want a use<Entity><Grid>Grid() state hook — sort/filter/pagination
//                wired to TanStack Query — for each `layout.dataGrid` an entity declares.
// emits:         <target>/<Entity>.grid.ts, plus the DB-free <Entity>.meta.ts descriptor
//                the hook module imports from. Emissions byte-identical to another UI
//                generator's copy of the same descriptor collapse to one file (#266).
// customize:     this generator is YOURS. `renderGridHookFile` (exported from
//                @metaobjectsdev/codegen-ts-tanstack) produces the hook body — wrap it,
//                prepend to it, or replace the call entirely with your own renderer.
// composes-with: grid.ts (the column definitions this hook's grid state pairs with) —
//                pass the SAME `tphSubtypeGrids` predicate to both, or a TPH subtype gets
//                a .grid.ts with no .columns.tsx beside it (#287).

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
import {
  renderGridHookFile,
  hasDataGridLayout,
  warnMissingDataGridLayout,
} from "@metaobjectsdev/codegen-ts-tanstack";

export interface TanstackGridHookOpts {
  filter?: (entity: MetaObject) => boolean;
  /**
   * Opt a TPH subtype IN to its own per-subtype grid. Default `() => false`: a
   * discriminator base emits ONE polymorphic grid and its subtypes emit none, which is
   * the single-source-of-truth arrangement almost every TPH model wants.
   *
   * This is an OPTION rather than a `filter` clause because it WIDENS. A `filter` is
   * ANDed with the built-in gates, so it can only ever narrow — an opt-in is not
   * expressible through it. (It is not a metadata attribute either: `@emitGrid` was
   * never registered vocabulary, so authoring it failed `meta verify`.)
   *
   * Pass the SAME predicate to `tanstackGrid()` and `tanstackGridHook()`. If they
   * disagree you reproduce #287 exactly: the hook emits a `<Sub>.grid.ts` whose sibling
   * `<Sub>.columns.tsx` is never emitted — a dangling `use<Sub>DefaultGrid()`, and an
   * outright TS2307 when the inherited layout carries an `@filter` preset, since the hook
   * then imports `<sub>DefaultFilter` from the missing columns module.
   */
  tphSubtypeGrids?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity generator that emits <Entity>.grid.ts — one
 * use<Entity><Grid>Grid() hook per layout[dataGrid] declared on the entity.
 *
 * Per-entity opt-IN: presence of at least one dataGrid layout on the object
 * (mirrors tanstackGrid).
 *
 * A TPH subtype additionally needs `tphSubtypeGrids` — pass the SAME predicate to
 * tanstackGrid(), or this generator emits a `<Sub>.grid.ts` with no `<Sub>.columns.tsx`
 * beside it.
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const tanstackGridHook = function tanstackGridHook(opts?: TanstackGridHookOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Default OFF — byte-identical to the behaviour every project that never declared a
  // per-subtype grid already had.
  const tphSubtypeGrids = opts?.tphSubtypeGrids ?? (() => false);
  // Every gate EXCEPT the dataGrid-layout opt-in: the framework instance-artifact
  // guard (skips abstract types) and the user filter. Split out so the discoverability
  // note can name exactly the entities the LAYOUT gate alone held back (#287).
  //
  // The TPH clause must MATCH tanstackGrid's exactly, which means the SAME
  // `tphSubtypeGrids` predicate must be passed to both. A TPH subtype inherits its base's
  // dataGrid layout via extends, so `hasDataGridLayout` is true for it — but tanstackGrid
  // deliberately emits no per-subtype columns unless `tphSubtypeGrids` opts it in (the
  // base's polymorphic grid is the single source of truth). Where the two predicates
  // disagree, a TPH subtype gets a `<Sub>.grid.ts` whose sibling `<Sub>.columns.tsx` is
  // never emitted: a dangling `use<Sub>DefaultGrid()` with nothing to pair it with, and an
  // outright TS2307 when the inherited layout carries an `@filter` preset (the hook then
  // imports `<sub>DefaultFilter` from the missing columns module).
  const passesOtherGates = (e: MetaObject): boolean =>
    servesReadApi(e)
    && userFilter(e)
    && (!isTphSubtype(e) || tphSubtypeGrids(e));
  const emit = perEntity(async (entity: MetaObject, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("tanstack-grid-hook: renderContext is required (provided by runGen)");
    }
    // Also emit the DB-free descriptor module this file imports from. Each UI
    // generator emits it rather than relying on the consumer wiring an extra one:
    // the entity generator is scaffold-and-own (ADR-0034), so it cannot be changed
    // from the package. Emissions are byte-identical between generators, which the
    // runner collapses (#266).
    //
    // §A6 fix round 3 — same resolveObjectNames + imp(...) pair every other §A6
    // site builds, scoped to THIS generator's own render context (see hooks.ts's
    // matching comment for why `.meta.ts` needs its own target-scoped check
    // rather than reusing the entity module's).
    const rc = ctx.renderContext;
    const metaNames = rc.includeNames ? resolveObjectNames(entity, rc.columnNamingStrategy) : undefined;
    const metaNamesSym: Code | undefined =
      metaNames === undefined
        ? undefined
        : code`${imp(`${entity.name}Names@${siblingSpecifier(rc.selfTarget, entity.package, `${entity.name}.names`, rc.extStyle)}`)}`;
    return [{
      path: entityOutputPath(ctx.renderContext.outputLayout, entity.package,
        entityMetaFileName(entity.name)),
      content: await formatTs(renderEntityMetaFile(
        entity,
        ctx.renderContext.apiPrefix,
        metaNames !== undefined && metaNamesSym !== undefined
          ? { name: metaNames.name, symbol: metaNamesSym }
          : undefined,
      )),
    }, {
      path: entityOutputPath(
        ctx.renderContext.outputLayout,
        entity.package,
        `${entity.name}.grid.ts`,
      ),
      content: withClientDirective(
        await formatTs(renderGridHookFile(entity, ctx.renderContext)),
        ctx.renderContext.clientDirective,
      ),
    }];
  });
  const generator: Generator = {
    name: "tanstack-grid-hook",
    filter: (e: MetaObject) => passesOtherGates(e) && hasDataGridLayout(e),
    generate: async (ctx) => {
      warnMissingDataGridLayout(ctx, passesOtherGates, "<Entity>.grid.ts");
      return emit(ctx);
    },
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackGridHookOpts | void>;
