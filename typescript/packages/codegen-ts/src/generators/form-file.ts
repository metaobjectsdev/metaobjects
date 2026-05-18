import type { MetaObject } from "@metaobjects/metadata";
import { perEntity, type Generator, type GeneratorFactory } from "../generator.js";
import { renderFormFile } from "../templates/form-file.js";

export interface FormFileOpts {
  filter?: (entity: MetaObject) => boolean;
}

/**
 * Forms are opt-in: a user must add `formFile()` to config.generators.
 * Per-entity opt-out via `@emitForm: false` is honored.
 * .tsx files are not piped through formatTs (Biome only handles .ts here).
 */
export const formFile = function formFile(opts?: FormFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  return {
    name: "form-file",
    // Always set: AND-composes metadata opt-out with optional user filter.
    filter: (e: MetaObject) => e.ownAttr("emitForm") !== false && userFilter(e),
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("form-file: renderContext is required (provided by runGen)");
      }
      return {
        path: `${entity.name}.form.tsx`,
        content: renderFormFile(entity, ctx.renderContext),
      };
    }),
  };
} as GeneratorFactory<FormFileOpts>;
