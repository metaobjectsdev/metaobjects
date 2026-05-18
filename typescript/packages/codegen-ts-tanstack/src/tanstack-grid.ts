import type { MetaObject } from "@metaobjects/metadata";
import { TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs } from "@metaobjects/codegen-ts";
import { renderColumnsFile } from "./templates/columns-file.js";

export interface TanstackGridOpts {
  filter?: (entity: MetaObject) => boolean;
}

function hasDataGridLayout(entity: MetaObject): boolean {
  // No typed `layouts()` accessor on MetaObject — filter effectiveChildren() by
  // type tag so inherited layouts (from extends:/super:) are still considered.
  return entity.effectiveChildren().some(
    (c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID,
  );
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
      e.attr("emitTanstack") !== false
      && userFilter(e)
      && hasDataGridLayout(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("tanstack-grid: renderContext is required (provided by runGen)");
      }
      return {
        path: `${entity.name}.columns.tsx`,
        content: await formatTs(renderColumnsFile(entity, ctx.renderContext)),
      };
    }),
  };
} as GeneratorFactory<TanstackGridOpts | void>;
