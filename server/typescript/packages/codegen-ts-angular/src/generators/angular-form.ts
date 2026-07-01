import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
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
 * Per-entity opt-out via `@emitAngular: false`.
 */
export const angularFormFile = function angularFormFile(
  opts?: AngularFormOpts,
): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "angular-form",
    // ADR-0039: resolving — a concrete entity may inherit @emitAngular via extends.
    filter: (e: MetaObject) => e.attr("emitAngular") !== false && userFilter(e),
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
