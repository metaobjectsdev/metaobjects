import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  servesReadApi,
  effectivePackage,
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
 * Decide per generator what you consume: wire only the generators whose output you
 * actually import, and narrow this one with its `filter` option. There is no `@emit*`
 * metadata attribute — those were never registered vocabulary, so `meta verify` rejects
 * them (ERR_UNKNOWN_ATTR).
 */
export const angularServiceFile = function angularServiceFile(
  opts?: AngularServiceOpts,
): Generator {
  const userFilter = opts?.filter ?? (() => true);
  const generator: Generator = {
    name: "angular-service",
    // Marks this generator as part of the CLIENT UI tier — the runner aggregates it
    // into ctx.config.includeUiTier so `agent/ui.md` describes a tier that this run
    // actually emits, rather than one the metadata merely permits.
    emitsUiTier: true,
    // A service is a client of a generated READ endpoint — no endpoint, no service
    // (an `object.value`, a sourceless entity/projection or an abstract object has
    // nothing to fetch, and its emitted output could never compile; see api-surface.ts).
    filter: (e: MetaObject) => servesReadApi(e) && userFilter(e),
    generate: perEntity(async (entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("angular-service: renderContext is required (provided by runGen)");
      }
      return {
        path: entityOutputPath(ctx.renderContext.outputLayout, effectivePackage(entity), `${entity.name}.service.ts`),
        content: await formatTs(renderServiceFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AngularServiceOpts | void>;
