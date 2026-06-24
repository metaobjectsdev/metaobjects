import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type EmittedFile, type GenContext, type Generator, type GeneratorFactory } from "../generator.js";
import { renderEntityFile } from "../templates/entity-file.js";
import { renderSharedEnumsFile, SHARED_ENUMS_BASENAME } from "../templates/enums-file.js";
import { formatTs } from "../format.js";
import { entityOutputPath } from "../import-path.js";
import { isAbstract } from "../instance-artifacts.js";

export interface EntityFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
  /**
   * Whether generated entity files include the Fastify-flavored
   * `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` blocks (and the
   * `@metaobjectsdev/runtime-ts/drizzle-fastify` type-only imports they
   * require). Default `true` for back-compat.
   *
   * Set to `false` for Worker/Lambda-style consumers that don't mount
   * Fastify-style server routes — the generated entity file then has no
   * `runtime-ts/drizzle-fastify` imports at all and `@metaobjectsdev/runtime-ts`
   * can be omitted from the consumer's dependency tree.
   *
   * The client-side `<Entity>Filter` type is always emitted — it's a pure
   * client-side type with no runtime-ts dependency.
   */
  allowlists?: boolean;
}

export const entityFile = function entityFile(opts?: EntityFileOpts): Generator {
  const allowlists = opts?.allowlists ?? true;
  const perEntityEmit = perEntity(async (entity, ctx) => {
    if (!ctx.renderContext) {
      throw new Error("entity-file: renderContext is required (provided by runGen)");
    }
    // Abstract entities contribute shape only. When emitAbstractShapes is off
    // (cross-port knob; default on) the entity-file generator emits nothing for
    // them. Instance/write generators skip abstract unconditionally elsewhere.
    if (isAbstract(entity) && !ctx.renderContext.emitAbstractShapes) {
      return [];
    }
    return {
      path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.ts`),
      content: await formatTs(renderEntityFile(entity, ctx.renderContext, { allowlists })),
    };
  });

  const generator: Generator = {
    name: "entity-file",
    emitsEntityModule: true,
    generate: async (ctx: GenContext): Promise<EmittedFile[]> => {
      const files = await perEntityEmit(ctx);
      // FR-019: emit the shared-enums module ONCE per run, into the entity-module
      // target root. Returns null (no file) when the model uses no materialized
      // shared enums — keeping the inline-enum default byte-identical (no new file).
      const sharedEnums = renderSharedEnumsFile(ctx.loadedRoot);
      if (sharedEnums !== null) {
        files.push({
          path: `${SHARED_ENUMS_BASENAME}.ts`,
          content: await formatTs(sharedEnums),
        });
      }
      return files;
    },
  };
  if (opts?.filter) {
    generator.filter = opts.filter;
  }
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<EntityFileOpts>;
