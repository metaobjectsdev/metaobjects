import type { MetaModel } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderEntityFile } from "../templates/entity-file.js";
import { formatTs } from "../format.js";

export interface EntityFileOpts {
  filter?: (entity: MetaModel) => boolean;
}

export const entityFile = function entityFile(opts?: EntityFileOpts): Generator {
  const generator: Generator = {
    name: "entity-file",
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("entity-file: renderContext is required (provided by runGen)");
      }
      return {
        path: `${entity.name}.ts`,
        content: await formatTs(renderEntityFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  return generator;
} as GeneratorFactory<EntityFileOpts | void>;
