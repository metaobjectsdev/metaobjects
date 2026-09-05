// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/form.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { formFile } from "./codegen/generators/form.js";
//
// RUNTIME: this file executes under whatever runs `meta gen` — NODE, even in a Bun
// project. Do not reach for `Bun.*` globals here.
// targets:       React with react-hook-form. The emitted component calls `useEntityForm`
//                from `@metaobjectsdev/react`, so it is a CLIENT component.
//                If your framework compiles server and client from one tree and resolves
//                each half under different conditions, the emitted file may need a marker
//                directive — prepend it to `renderFormFile`'s result below. That is a
//                one-line change in THIS file and is the intended way to do it.
// use-when:      you want a generated form per writable entity.
// emits:         <target>/<Entity>.form.tsx
// customize:     this generator is YOURS. `renderFormFile` (exported from
//                @metaobjectsdev/codegen-ts-react) produces the component body — wrap it,
//                prepend to it, or replace the call entirely with your own renderer.
// composes-with: entity.ts (imports the schemas the form validates against).

import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  entityOutputPath,
  hasGeneratedForm,
  withClientDirective,
} from "@metaobjectsdev/codegen-ts";
import { renderFormFile } from "@metaobjectsdev/codegen-ts-react";

export interface FormFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Forms are opt-in: a user must add `formFile()` to config.generators.
 * .tsx files are not piped through formatTs (Biome only handles .ts here).
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const formFile = function formFile(opts?: FormFileOpts): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "form-file",
    // Always set: AND-composes the framework write-artifact guard
    // (skips abstract types — no instance — and read-only projections —
    // instantiable for read, never for write) with the optional user filter.
    // FR-017 Tier 3: forms are ALWAYS per-subtype. The discriminator base gets
    // NO form (you can't create an abstract base), but each concrete subtype
    // does — even though it has no own writable source (it inherits the base's).
    filter: (e: MetaObject) => {
      // `hasGeneratedForm` (api-surface.ts) holds the whole rule: per-subtype form for a
      // TPH subtype, NO form for a discriminator base (you cannot create a base, and its
      // polymorphic mount is read-only by construction), and a write endpoint that is not
      // a read-only projection otherwise. It is shared with `agent/ui.md`, which has to
      // say "there is deliberately no form here" for exactly the set skipped here — asking
      // `servesWriteApi` there instead announced a form for every discriminator base.
      return userFilter(e) && hasGeneratedForm(e);
    },
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("form-file: renderContext is required (provided by runGen)");
      }
      // The framework-coupled seam. `withClientDirective` applies the project-level
      // `clientDirective` config knob (FR-040 §6.4); for a directive your framework
      // needs that MetaObjects does not model, prepend it right here.
      const body = withClientDirective(
        renderFormFile(entity, ctx.renderContext),
        ctx.renderContext.clientDirective,
      );
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.form.tsx`),
        content: body,
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<FormFileOpts>;
