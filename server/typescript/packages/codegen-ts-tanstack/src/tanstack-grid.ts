import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, formatTs, entityOutputPath, servesReadApi, isTphSubtype, CODEGEN_ATTR_EMIT_TANSTACK, CODEGEN_ATTR_EMIT_GRID,
  withClientDirective,
} from "@metaobjectsdev/codegen-ts";
import { hasDataGridLayout, warnMissingDataGridLayout } from "./data-grid-gate.js";
import { renderColumnsFile } from "./templates/columns-file.js";

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
