import { oncePerRun, type Generator, type GeneratorFactory } from "../generator.js";
import { renderBarrel } from "../templates/barrel.js";
import { formatTs } from "../format.js";
import { effectivePackage } from "../docs-paths.js";
import { claimBarrelNames } from "../naming/name-claims.js";

export interface BarrelOpts {
  target?: string;
}

export const barrel = function barrel(opts?: BarrelOpts): Generator {
  const generator: Generator = {
    name: "barrel",
    generate: oncePerRun(async (entities, ctx) => {
      // Ruling R52: every name the barrel re-exports lives in its one namespace.
      for (const e of entities) claimBarrelNames(ctx, e);
      return {
      path: "index.ts",
      content: await formatTs(
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: effectivePackage(e) })),
          ctx.renderContext!.extStyle,
          ctx.renderContext!.selfTarget,
          ctx.renderContext!.entityModuleTarget,
        ),
      ),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<BarrelOpts>;
