import { OBJECT_SUBTYPE_VALUE, type MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderQueriesFile } from "../templates/queries-file.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface QueriesFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

// object.value records have no primary identity, so the rendered queries module
// emits findById/updateById/deleteById against a non-existent column. Skipping
// value subtypes is unconditional — the user-supplied filter (if any) is applied
// on top via boolean AND.
const skipValueTypes = (e: MetaObject): boolean => e.subType !== OBJECT_SUBTYPE_VALUE;

export const queriesFile = function queriesFile(opts?: QueriesFileOpts): Generator {
  const userFilter = opts?.filter;
  const filter: (e: MetaObject) => boolean = userFilter
    ? (e) => skipValueTypes(e) && userFilter(e)
    : skipValueTypes;

  const generator: Generator = {
    name: "queries-file",
    filter,
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
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<QueriesFileOpts>;
