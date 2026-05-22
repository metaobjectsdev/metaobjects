import { oncePerRun, type Generator, type GeneratorFactory } from "../generator.js";
import { renderBarrel } from "../templates/barrel.js";
import { formatTs } from "../format.js";

export interface BarrelOpts {
  target?: string;
}

export const barrel = function barrel(opts?: BarrelOpts): Generator {
  const generator: Generator = {
    name: "barrel",
    generate: oncePerRun(async (entities, ctx) => ({
      path: "index.ts",
      content: await formatTs(
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: e.package })),
          ctx.renderContext!.extStyle,
          ctx.renderContext!.selfTarget.outputLayout,
        ),
      ),
    })),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<BarrelOpts>;
