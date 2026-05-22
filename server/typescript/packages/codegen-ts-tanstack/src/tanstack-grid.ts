import type { MetaObject } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath } from "@metaobjectsdev/codegen-ts";
import { renderColumnsFile } from "./templates/columns-file.js";

export interface TanstackGridOpts {
  filter?: (entity: MetaObject) => boolean;
}

function hasDataGridLayout(entity: MetaObject): boolean {
  // layouts() is effective — own + inherited layouts (from extends:/super:).
  return entity.layouts().some((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
}

/**
 * Per-entity opt-out via `@emitTanstack: false`. Per-entity opt-IN: presence of
 * at least one `dataGrid` layout on the object. If both pass and the user-supplied
 * filter passes, the generator emits.
 */
export const tanstackGrid = function tanstackGrid(opts?: TanstackGridOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  return {
    name: "tanstack-grid",
    // Always set: AND-composes opt-out, user filter, and dataGrid layout presence.
    filter: (e: MetaObject) =>
      e.ownAttr("emitTanstack") !== false
      && userFilter(e)
      && hasDataGridLayout(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("tanstack-grid: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.columns.tsx`),
        content: await formatTs(renderColumnsFile(entity, ctx.renderContext)),
      };
    }),
  };
} as GeneratorFactory<TanstackGridOpts | void>;
