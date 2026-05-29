import type { MetaObject } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, entityOutputPath, emitsWriteArtifacts } from "@metaobjectsdev/codegen-ts";
import { renderFormFile } from "./templates/form-file.js";

export interface FormFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Forms are opt-in: a user must add `formFile()` to config.generators.
 * Per-entity opt-out via `@emitForm: false` is honored.
 * .tsx files are not piped through formatTs (Biome only handles .ts here).
 */
export const formFile = function formFile(opts?: FormFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "form-file",
    // Always set: AND-composes the framework write-artifact guard
    // (skips abstract types — no instance — and read-only projections —
    // instantiable for read, never for write), the metadata opt-out, and
    // the optional user filter.
    filter: (e: MetaObject) => emitsWriteArtifacts(e) && e.ownAttr("emitForm") !== false && userFilter(e),
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("form-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.form.tsx`),
        content: renderFormFile(entity, ctx.renderContext),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<FormFileOpts>;
