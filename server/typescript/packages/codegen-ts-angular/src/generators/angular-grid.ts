import type { MetaObject } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  servesReadApi,
} from "@metaobjectsdev/codegen-ts";
import { renderGridFile } from "../templates/grid-file.js";

export interface AngularGridOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

function hasDataGridLayout(entity: MetaObject): boolean {
  return entity.layouts().some((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
}

/**
 * Per-entity Angular grid-component generator. Emits
 * `<Entity>.grid.component.ts` — a standalone component over
 * `<mo-entity-grid>` with column defs derived from `layout.dataGrid` metadata.
 *
 * Per-entity opt-in via presence of at least one `dataGrid` layout child.
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const angularGridFile = function angularGridFile(
  opts?: AngularGridOpts,
): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "angular-grid",
    filter: (e: MetaObject) =>
      // A grid renders what a generated READ endpoint returns — no endpoint, no grid
      // (see api-surface.ts).
      servesReadApi(e) && userFilter(e) && hasDataGridLayout(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("angular-grid: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.grid.component.ts`),
        content: await formatTs(renderGridFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AngularGridOpts | void>;
