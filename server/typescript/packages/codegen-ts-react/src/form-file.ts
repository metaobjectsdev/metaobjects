import type { MetaObject } from "@metaobjectsdev/metadata";
import { OBJECT_ATTR_DISCRIMINATOR } from "@metaobjectsdev/metadata";
import { perEntity, type Generator, type GeneratorFactory, entityOutputPath, servesWriteApi, isProjection, isTphSubtype, CODEGEN_ATTR_EMIT_FORM, withClientDirective } from "@metaobjectsdev/codegen-ts";
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
    // FR-017 Tier 3: forms are ALWAYS per-subtype. The discriminator base gets
    // NO form (you can't create an abstract base), but each concrete subtype
    // does — even though it has no own writable source (it inherits the base's).
    filter: (e: MetaObject) => {
      // ADR-0039: resolving — a concrete entity may inherit @emitForm via extends.
      if (e.attr(CODEGEN_ATTR_EMIT_FORM) === false) return false;
      if (!userFilter(e)) return false;
      if (isTphSubtype(e)) return true; // per-subtype form
      // A discriminator base is never form-rendered directly.
      // ADR-0039: own — @discriminator identifies a TPH base level (read own so a
      // subtype isn't mistaken for a base); e is already known not to be a subtype.
      if (typeof e.ownAttr(OBJECT_ATTR_DISCRIMINATOR) === "string") return false;
      // A form is a client of a WRITE endpoint. Ask whether one exists, not where the
      // data is stored — see api-surface.ts. `!isProjection` stays explicit here: a
      // read-only view is a UI-tier exclusion (nothing to submit), distinct from
      // whether write endpoints exist at all.
      return servesWriteApi(e) && !isProjection(e);
    },
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("form-file: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.form.tsx`),
        content: withClientDirective(
          renderFormFile(entity, ctx.renderContext),
          ctx.renderContext.clientDirective,
        ),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<FormFileOpts>;
