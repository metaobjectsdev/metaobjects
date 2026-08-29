// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/grid.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { tanstackGrid } from "./codegen/generators/grid.js";
//
// RUNTIME: this file executes under whatever runs `meta gen` — NODE, even in a Bun
// project. Do not reach for `Bun.*` globals here.
// targets:       TanStack Table. The emitted module's `ColumnDef` comes from
//                `@tanstack/react-table`, so it is a CLIENT component.
//                If your framework compiles server and client from one tree and resolves
//                each half under different conditions, the emitted file may need a marker
//                directive — prepend it to `renderColumnsFile`'s result below. That is a
//                one-line change in THIS file and is the intended way to do it.
// use-when:      you want generated grid column definitions for any entity declaring a
//                `layout.dataGrid` child.
// emits:         <target>/<Entity>.columns.tsx — one column set per declared dataGrid
//                layout; a TPH discriminator base's grid folds in its subtypes' fields.
// customize:     this generator is YOURS. `renderColumnsFile` (exported from
//                @metaobjectsdev/codegen-ts-tanstack) produces the column definitions —
//                wrap it, prepend to it, or replace the call entirely with your own
//                renderer.
// composes-with: entity.ts (imports the Row type the columns are typed against),
//                hooks.ts (the query hook a grid usually pairs with).

import { type MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  servesReadApi,
  isTphSubtype,
  CODEGEN_ATTR_EMIT_TANSTACK,
  CODEGEN_ATTR_EMIT_GRID,
} from "@metaobjectsdev/codegen-ts";
import {
  renderColumnsFile,
  hasDataGridLayout,
  warnMissingDataGridLayout,
} from "@metaobjectsdev/codegen-ts-tanstack";

export interface TanstackGridOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity opt-out via `@emitTanstack: false`. Per-entity opt-IN: presence of
 * at least one `dataGrid` layout on the object. If both pass and the user-supplied
 * filter passes, the generator emits.
 */
export const tanstackGrid = function tanstackGrid(opts?: TanstackGridOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  // Every gate EXCEPT the dataGrid-layout opt-in: the framework instance-artifact
  // guard (skips abstract types), the metadata opt-out, and the user filter.
  // FR-017 Tier 3: a TPH discriminator base emits ONE polymorphic grid. Its
  // subtypes inherit the base's dataGrid layout via extends, but per-subtype grids
  // are opt-IN only (own `@emitGrid: true`) — otherwise the polymorphic grid is the
  // single source of truth.
  // Split out so the discoverability note can name exactly the entities the LAYOUT
  // gate alone held back (#287) — an opted-out or abstract type is not a surprise.
  const passesOtherGates = (e: MetaObject): boolean =>
    servesReadApi(e)
    // ADR-0039: resolving — a concrete entity may inherit its @emit* opt-out flag via extends.
    && e.attr(CODEGEN_ATTR_EMIT_TANSTACK) !== false
    && userFilter(e)
    && (!isTphSubtype(e) || e.attr(CODEGEN_ATTR_EMIT_GRID) === true);
  const emit = perEntity(async (entity: MetaObject, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("tanstack-grid: renderContext is required (provided by runGen)");
    }
    return {
      path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.columns.tsx`),
      content: await formatTs(renderColumnsFile(entity, ctx.renderContext)),
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
