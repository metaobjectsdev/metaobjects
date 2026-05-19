import type { MetaObject } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderQueriesFile } from "../templates/queries-file.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface QueriesFileOpts {
  filter?: (entity: MetaObject) => boolean;
}

export const queriesFile = function queriesFile(opts?: QueriesFileOpts): Generator {
  const generator: Generator = {
    name: "queries-file",
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("queries-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.queries.ts`),
        content: await formatTs(renderQueriesFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  return generator;
} as GeneratorFactory<QueriesFileOpts>;
