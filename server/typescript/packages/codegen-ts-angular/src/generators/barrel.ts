import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  oncePerRun,
  type Generator,
  type GeneratorFactory,
  formatTs,
  packageToPath,
  servesReadApi,
  servesWriteApi,
  isProjection,
} from "@metaobjectsdev/codegen-ts";
import {
  GENERATED_HEADER,
} from "@metaobjectsdev/codegen-ts";
import { LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata";

export interface AngularBarrelOpts {
  target?: string;
}

function specifierFor(layout: string, pkg: string | undefined, stem: string): string {
  if (layout === "flat") return `./${stem}`;
  const dir = packageToPath(pkg);
  return dir === "" ? `./${stem}` : `./${dir}/${stem}`;
}

function isAngularEmittable(entity: MetaObject): boolean {
  // ADR-0039: resolving — a concrete entity may inherit its @emit* opt-out flag via extends.
  return entity.attr("emitAngular") !== false;
}

function hasDataGridLayout(entity: MetaObject): boolean {
  return entity.layouts().some((l) => l.subType === LAYOUT_SUBTYPE_DATA_GRID);
}

/**
 * Aggregate re-export barrel for all per-entity Angular outputs (service +
 * form + grid). Each re-export line mirrors its generator's filter: service +
 * grid require a READ endpoint, the form a WRITE endpoint on a non-projection,
 * and the grid additionally a `layout.dataGrid` child.
 *
 * Emits `index.ts` at the target's outDir root. Stable alphabetical order.
 */
export const barrel = function barrel(opts?: AngularBarrelOpts): Generator {
  const generator: Generator = {
    name: "angular-barrel",
    generate: oncePerRun(async (entities, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("angular-barrel: renderContext is required (provided by runGen)");
      }
      const layout = ctx.renderContext.outputLayout;
      const lines: string[] = [];
      const eligible = entities
        .filter(isAngularEmittable)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const e of eligible) {
        // Each line mirrors its generator's filter exactly — a re-export of a file
        // that was never emitted is a hard build break in the consumer app.
        if (servesReadApi(e)) {
          lines.push(`export * from ${JSON.stringify(specifierFor(layout, e.package, `${e.name}.service`))};`);
        }
        if (servesWriteApi(e) && !isProjection(e)) {
          lines.push(`export * from ${JSON.stringify(specifierFor(layout, e.package, `${e.name}.form.component`))};`);
        }
        if (servesReadApi(e) && hasDataGridLayout(e)) {
          lines.push(`export * from ${JSON.stringify(specifierFor(layout, e.package, `${e.name}.grid.component`))};`);
        }
      }
      const content = `// ${GENERATED_HEADER}-angular — DO NOT EDIT.\n${lines.join("\n")}\n`;
      return {
        path: "index.ts",
        content: await formatTs(content),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AngularBarrelOpts | void>;
