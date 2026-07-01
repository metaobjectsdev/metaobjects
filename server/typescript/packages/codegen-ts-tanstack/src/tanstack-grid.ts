import type { MetaObject } from "@metaobjectsdev/metadata";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, emitsInstanceArtifacts, isTphSubtype, CODEGEN_ATTR_EMIT_TANSTACK, CODEGEN_ATTR_EMIT_GRID } from "@metaobjectsdev/codegen-ts";
import { renderColumnsFile } from "./templates/columns-file.js";

export interface TanstackGridOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
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
  const generator: Generator = {
    name: "tanstack-grid",
    // Always set: AND-composes the framework instance-artifact guard (skips
    // abstract types), opt-out, user filter, and dataGrid layout presence.
    // FR-017 Tier 3: a TPH discriminator base emits ONE polymorphic grid. Its
    // subtypes inherit the base's dataGrid layout via extends, but per-subtype
    // grids are opt-IN only (own `@emitGrid: true`) — otherwise the polymorphic
    // grid is the single source of truth.
    filter: (e: MetaObject) =>
      emitsInstanceArtifacts(e)
      // ADR-0039: resolving — a concrete entity may inherit its @emit* opt-out flag via extends.
      && e.attr(CODEGEN_ATTR_EMIT_TANSTACK) !== false
      && userFilter(e)
      && hasDataGridLayout(e)
      && (!isTphSubtype(e) || e.attr(CODEGEN_ATTR_EMIT_GRID) === true),
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
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<TanstackGridOpts | void>;
