// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/service.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { serviceFile } from "./codegen/generators/service.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; use `node:` builtins instead.
// targets:       the emit step. Replace `renderServiceFiles` in `../templates/service-file.js` to
//                change an operation's SHAPE (an extra step, a different result type); keep
//                `serviceModelOf` so which entities get operations and what they are named stays
//                the packaged walk.
// use-when:      a route, a job, a queue consumer or an agent tool runs the model's writes, and
//                every write has to take the same transaction and the same write rules.
// emits:         <pkg path>/service/<operation>.ts (one function per derived list, get, create,
//                update and delete of every covered entity) and <pkg path>/service/index.ts (the
//                `<Pkg>Service` interface, `create<Pkg>Service(deps)` and each entity's wire
//                mapper), in either layout. A package with no covered entity gets no file.
// runtime:       the emitted files import the store mechanics (`service/` of
//                @metaobjectsdev/runtime-ts: the transaction, the row lock, the read-back, the
//                list query). `meta eject service` copies that source into `codegen/runtime/`
//                and the files import the copy; `runtimeImport: "@metaobjectsdev/runtime-ts"`
//                goes back to the package.
// customize:     swap the renderers; narrow with `filter`.
// composes-with: entity.ts (the Drizzle table and the allowlists) and contract-types.ts (the
//                shapes and schemas), both required in the same target; service-routes.ts mounts
//                the service on Fastify.
//
// A SEPARATE generator: a project that does not list it sees no change (fixtures/codegen-noop/rules).
import {
  ownedRuntimeImport,
  serviceModelOf,
  serviceRenderContext,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderServiceFiles } from "../templates/service-file.js";
import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";

export interface ServiceFileOpts {
  /** Narrow which entities get operations. ANDed with the generator's own gates, so it can only narrow. */
  filter?: (entity: MetaObject) => boolean;
  /**
   * Where the emitted files import the store mechanics from. Absent: the copy `meta eject service`
   * placed in `codegen/runtime/`. `"@metaobjectsdev/runtime-ts"` imports the package instead.
   */
  runtimeImport?: string;
  /** Named output target. It must be the entity module's target. */
  target?: string;
}

export function serviceFile(opts?: ServiceFileOpts): Generator {
  const generator: Generator = {
    name: "service",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = serviceModelOf(ctx.loadedRoot, { matches });
      if (model.length === 0) return [];
      const runtimeImport =
        opts?.runtimeImport ?? (ctx.renderContext && ownedRuntimeImport(ctx.projectRoot ?? ".", ctx.renderContext.selfTarget.outDir));
      const rc = serviceRenderContext(ctx, "service", runtimeImport);
      return model.flatMap((pkg) => renderServiceFiles(pkg, rc));
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
