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
// composes-with: grid.ts (the column definitions this hook's grid state pairs with).

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
  CODEGEN_ATTR_EMIT_TANSTACK,
  CODEGEN_ATTR_EMIT_GRID,
  withClientDirective,
} from "@metaobjectsdev/codegen-ts";
import {
  renderGridHookFile,
  hasDataGridLayout,
  warnMissingDataGridLayout,
} from "@metaobjectsdev/codegen-ts-tanstack";

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
