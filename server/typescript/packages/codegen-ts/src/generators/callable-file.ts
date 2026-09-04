// FR-015 callable-wrapper generator factory.
//
// One file per entity backed by a stored procedure or table function:
//   <outDir>/<package>/<Entity>.callable.ts
//
// Non-callable entities are skipped (filter narrows the iteration set so
// vanilla tables/views never emit a noisy empty file).

import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderCallableFile, isCallableEntity } from "../templates/callable-file.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";

export interface CallableFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const callableFile = function callableFile(opts?: CallableFileOpts): Generator {
  const userFilter = opts?.filter;
  const filter: (e: MetaObject) => boolean = userFilter
    ? (e) => isCallableEntity(e) && userFilter(e)
    : isCallableEntity;

  const generator: Generator = {
    name: "callable-file",
    filter,
    generate: perEntity(async (entity, ctx) => {
      return {
        path: entityOutputPath(
          ctx.config.outputLayout ?? "flat",
          entity.package,
          `${entity.name}.callable.ts`,
        ),
        content: await formatTs(renderCallableFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<CallableFileOpts>;
