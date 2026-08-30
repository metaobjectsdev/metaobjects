import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, entityMetaFileName, renderEntityMetaFile, servesReadApi, isTphSubtype, CODEGEN_ATTR_EMIT_TANSTACK, CODEGEN_ATTR_EMIT_GRID,
  withClientDirective,
} from "@metaobjectsdev/codegen-ts";
import { hasDataGridLayout, warnMissingDataGridLayout } from "./data-grid-gate.js";
import { renderGridHookFile } from "./templates/grid-hook-file.js";

export interface TanstackGridHookOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity generator that emits <Entity>.grid.ts — one
 * use<Entity><Grid>Grid() hook per layout[dataGrid] declared on the entity.
 *
 * Per-entity opt-out via @emitTanstack: false. Per-entity opt-IN: presence of
 * at least one dataGrid layout on the object (mirrors tanstackGrid).
 */
export const tanstackGridHook = function tanstackGridHook(opts?: TanstackGridHookOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Every gate EXCEPT the dataGrid-layout opt-in: the framework instance-artifact
  // guard (skips abstract types), the metadata opt-out, and the user filter. Split
  // out so the discoverability note can name exactly the entities the LAYOUT gate
  // alone held back (#287).
  //
  // The TPH clause must MATCH tanstackGrid's exactly. A TPH subtype inherits its base's
  // dataGrid layout via extends, so `hasDataGridLayout` is true for it — but tanstackGrid
  // deliberately emits no per-subtype columns without an own `@emitGrid: true` (the base's
  // polymorphic grid is the single source of truth). Without the same clause here, a TPH
  // subtype got a `<Sub>.grid.ts` whose sibling `<Sub>.columns.tsx` is never emitted:
  // a dangling `use<Sub>DefaultGrid()` with nothing to pair it with, and an outright
  // TS2307 when the inherited layout carries an `@filter` preset (the hook then imports
  // `<sub>DefaultFilter` from the missing columns module).
  const passesOtherGates = (e: MetaObject): boolean =>
    servesReadApi(e)
    // ADR-0039: resolving — a concrete entity may inherit its @emit* opt-out flag via extends.
    && e.attr(CODEGEN_ATTR_EMIT_TANSTACK) !== false
    && userFilter(e)
    && (!isTphSubtype(e) || e.attr(CODEGEN_ATTR_EMIT_GRID) === true);
  const emit = perEntity(async (entity: MetaObject, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("tanstack-grid-hook: renderContext is required (provided by runGen)");
    }
    // Also emit the DB-free descriptor module this file imports from. Each UI
    // generator emits it rather than relying on the consumer wiring an extra one:
    // the entity generator is scaffold-and-own (ADR-0034), so it cannot be changed
    // from the package. Emissions are byte-identical between generators, which the
    // runner collapses (#266).
    return [{
      path: entityOutputPath(ctx.renderContext.outputLayout, entity.package,
        entityMetaFileName(entity.name)),
      content: await formatTs(renderEntityMetaFile(entity, ctx.renderContext.apiPrefix)),
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
