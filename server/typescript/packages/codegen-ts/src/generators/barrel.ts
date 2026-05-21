import { oncePerRun, type Generator, type GeneratorFactory } from "../generator.js";
import { renderBarrel } from "../templates/barrel.js";
import { formatTs } from "../format.js";

export const barrel = function barrel(): Generator {
  return {
    name: "barrel",
    generate: oncePerRun(async (entities, ctx) => ({
      path: "index.ts",
      content: await formatTs(
        renderBarrel(
          entities.map((e) => ({ name: e.name, package: e.package })),
          ctx.config.extStyle,
          ctx.config.outputLayout ?? "flat",
        ),
      ),
    })),
  };
} as GeneratorFactory;
