import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  servesWriteApi,
  isProjection,
} from "@metaobjectsdev/codegen-ts";
import { renderFormFile } from "../templates/form-file.js";

export interface AngularFormOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity Angular form-component generator. Emits
 * `<Entity>.form.component.ts` — a standalone component using Angular reactive
 * forms + signal-based inputs. Form controls + validators are derived from
 * metadata (required, maxLength, …).
 *
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const angularFormFile = function angularFormFile(
  opts?: AngularFormOpts,
): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "angular-form",
    // A form is a client of generated WRITE endpoints — no writable source, no form
    // (mirrors codegen-ts-react's formFile; see api-surface.ts). `!isProjection`
    // stays explicit: a read-only view has nothing to submit even where write
    // endpoints exist on the base entity.
    filter: (e: MetaObject) =>
      servesWriteApi(e) && !isProjection(e) && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("angular-form: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.form.component.ts`),
        content: await formatTs(renderFormFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AngularFormOpts | void>;
