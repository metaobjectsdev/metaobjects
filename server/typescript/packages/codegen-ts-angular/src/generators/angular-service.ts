import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  servesReadApi,
} from "@metaobjectsdev/codegen-ts";
import { renderServiceFile } from "../templates/service-file.js";

export interface AngularServiceOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

/**
 * Per-entity Angular service generator. Emits `<Entity>.service.ts` with a
 * `@Injectable({ providedIn: 'root' })` class wrapping the injected
 * EntityFetcher with typed CRUD methods (list / get / create / update / delete).
 *
 * Per-entity opt-out via `@emitAngular: false`.
 */
export const angularServiceFile = function angularServiceFile(
  opts?: AngularServiceOpts,
): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "angular-service",
    // A service is a client of a generated READ endpoint — no endpoint, no service
    // (an `object.value`, a sourceless entity/projection or an abstract object has
    // nothing to fetch, and its emitted output could never compile; see api-surface.ts).
    // ADR-0039: resolving — a concrete entity may inherit @emitAngular via extends.
    filter: (e: MetaObject) =>
      servesReadApi(e) && e.attr("emitAngular") !== false && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("angular-service: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, entity.package, `${entity.name}.service.ts`),
        content: await formatTs(renderServiceFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AngularServiceOpts | void>;
