import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderEntityFile } from "../templates/entity-file.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface EntityFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const entityFile = function entityFile(opts?: EntityFileOpts): Generator {
  const generator: Generator = {
    name: "entity-file",
    emitsEntityModule: true,
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("entity-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.ts`),
        content: await formatTs(renderEntityFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<EntityFileOpts>;
