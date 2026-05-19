import type { MetaObject } from "@metaobjects/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath } from "@metaobjects/codegen-ts";
import { renderGridHookFile } from "./templates/grid-hook-file.js";

export interface TanstackGridHookOpts {
  filter?: (entity: MetaObject) => boolean;
}

function hasDataGridLayout(entity: MetaObject): boolean {
  // layouts() is effective — own + inherited layouts (from extends:/super:).
  return entity.layouts().some((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
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
  return {
    name: "tanstack-grid-hook",
    // AND-composes opt-out, user filter, and dataGrid layout presence.
    filter: (e: MetaObject) =>
      e.ownAttr("emitTanstack") !== false
      && userFilter(e)
      && hasDataGridLayout(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("tanstack-grid-hook: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(
          ctx.renderContext.outputLayout,
          entity.package,
          `${entity.name}.grid.ts`,
        ),
        content: await formatTs(renderGridHookFile(entity, ctx.renderContext)),
      };
    }),
  };
} as GeneratorFactory<TanstackGridHookOpts | void>;
