import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, servesReadApi, isTphSubtype,
  withClientDirective,
} from "@metaobjectsdev/codegen-ts";
import { hasDataGridLayout, warnMissingDataGridLayout } from "./data-grid-gate.js";
import { renderColumnsFile } from "./templates/columns-file.js";

export interface TanstackGridOpts {
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
 * Per-entity opt-IN: presence of at least one `dataGrid` layout on the object. If that
 * passes and the user-supplied filter passes, the generator emits.
 *
 * A TPH subtype additionally needs `tphSubtypeGrids` — pass the SAME predicate to
 * tanstackGridHook(), or the emitted `<Sub>.grid.ts` has no `<Sub>.columns.tsx`.
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const tanstackGrid = function tanstackGrid(opts?: TanstackGridOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Default OFF — byte-identical to the behaviour every project that never declared a
  // per-subtype grid already had.
  const tphSubtypeGrids = opts?.tphSubtypeGrids ?? (() => false);
  // Every gate EXCEPT the dataGrid-layout opt-in: the framework instance-artifact
  // guard (skips abstract types) and the user filter.
  // FR-017 Tier 3: a TPH discriminator base emits ONE polymorphic grid. Its
  // subtypes inherit the base's dataGrid layout via extends, but per-subtype grids
  // are opt-IN only, via the `tphSubtypeGrids` option — otherwise the polymorphic
  // grid is the single source of truth. Pass the SAME predicate to tanstackGridHook().
  // Split out so the discoverability note can name exactly the entities the LAYOUT
  // gate alone held back (#287) — an abstract type is not a surprise.
  const passesOtherGates = (e: MetaObject): boolean =>
    servesReadApi(e)
    && userFilter(e)
    && (!isTphSubtype(e) || tphSubtypeGrids(e));
  const emit = perEntity(async (entity: MetaObject, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("tanstack-grid: renderContext is required (provided by runGen)");
    }
    return {
      path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.columns.tsx`),
      content: withClientDirective(
        await formatTs(renderColumnsFile(entity, ctx.renderContext)),
        ctx.renderContext.clientDirective,
      ),
    };
  });
  const generator: Generator = {
    name: "tanstack-grid",
    filter: (e: MetaObject) => passesOtherGates(e) && hasDataGridLayout(e),
    generate: async (ctx) => {
      warnMissingDataGridLayout(ctx, passesOtherGates, "<Entity>.columns.tsx");
      return emit(ctx);
    },
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackGridOpts | void>;
