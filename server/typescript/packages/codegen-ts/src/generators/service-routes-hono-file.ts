import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { serviceModelOf, serviceRenderContext } from "../service-walk.js";
import { renderHonoTransport } from "../templates/service-file.js";

/**
 * The thin Hono transport of the service layer (ADR-0067 §1, layer 5): one file per metadata
 * package, `<pkg>/transport/hono.ts`, the `service-routes` routes on a Hono app. Each route reads a
 * request, calls the package's service and answers what it answered. It holds no rules, and it
 * imports the service module and the contract types only. Its `getActor(c)` option resolves who a
 * request is for; two routes on one method and path are refused when it is generated. The
 * built-in twin of `src/reference/service-routes-hono.ts`.
 */
export interface ServiceRoutesHonoFileOpts {
  /** Narrow which entities get routes. Keep it the same as the service generator's. */
  filter?: (entity: MetaObject) => boolean;
  /** Where the emitted file imports `@metaobjectsdev/runtime-ts/service/hono` from. Absent: the package. */
  runtimeImport?: string;
  /** Named output target. It must be the entity module's target. */
  target?: string;
}

export function serviceRoutesHonoFile(opts?: ServiceRoutesHonoFileOpts): Generator {
  const generator: Generator = {
    name: "service-routes-hono",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = serviceModelOf(ctx.loadedRoot, { matches });
      if (model.length === 0) return [];
      const rc = serviceRenderContext(ctx, "service-routes-hono", opts?.runtimeImport);
      return model.map((pkg) => renderHonoTransport(pkg, rc));
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
