// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/service-routes.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { serviceRoutesFile } from "./codegen/generators/service-routes.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; use `node:` builtins instead.
// targets:       the emit step. Replace `renderFastifyTransport` in `../templates/service-file.js`
//                to change the routes' SHAPE (a hook on every route, another status); keep
//                `serviceModelOf` so the routes cover exactly what the service does.
// use-when:      the service layer (service.ts) is served over REST on Fastify.
// emits:         <pkg path>/transport/fastify.ts per package with a covered entity: one Fastify
//                plugin, `<pkg>ServiceRoutes`, registered with the service it calls
//                (`app.register(blogServiceRoutes, { service })`). Each route parses the request,
//                calls one operation and sends what it answered; it holds no rules.
// runtime:       the emitted file imports the request and reply helpers (`service/fastify` of
//                @metaobjectsdev/runtime-ts). `meta eject service-routes` copies that source into
//                `codegen/runtime/` and the file imports the copy; `runtimeImport:
//                "@metaobjectsdev/runtime-ts"` goes back to the package.
// customize:     swap the renderer; narrow with `filter` (keep it the same as the service's).
// composes-with: service.ts and contract-types.ts, in the same target.
import {
  ownedRuntimeImport,
  serviceModelOf,
  serviceRenderContext,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderFastifyTransport } from "../templates/service-file.js";
import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";

export interface ServiceRoutesFileOpts {
  /** Narrow which entities get routes. Keep it the same as the service generator's. */
  filter?: (entity: MetaObject) => boolean;
  /**
   * Where the emitted file imports the request and reply helpers from. Absent: the copy
   * `meta eject service-routes` placed in `codegen/runtime/`. `"@metaobjectsdev/runtime-ts"`
   * imports the package instead.
   */
  runtimeImport?: string;
  /** Named output target. It must be the entity module's target. */
  target?: string;
}

export function serviceRoutesFile(opts?: ServiceRoutesFileOpts): Generator {
  const generator: Generator = {
    name: "service-routes",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = serviceModelOf(ctx.loadedRoot, { matches });
      if (model.length === 0) return [];
      const runtimeImport =
        opts?.runtimeImport ?? (ctx.renderContext && ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir));
      const rc = serviceRenderContext(ctx, "service-routes", runtimeImport);
      return model.map((pkg) => renderFastifyTransport(pkg, rc));
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
