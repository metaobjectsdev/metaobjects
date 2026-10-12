// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/callable.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { callableFile } from "./codegen/generators/callable.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Drizzle on Postgres. The emitted wrapper takes `db` as a PARAMETER and
//                runs a parameterised `SELECT * FROM <proc>(…)` through `db.execute`.
// use-when:      an object is backed by a stored procedure or a table function
//                (`source.rdb` with `@kind: storedProc` or `tableFunction`) and you want a
//                typed `call<Entity>(db, args)` instead of hand-writing the SQL call.
// emits:         <target>/<Entity>.callable.ts per object with a callable source — typed
//                args from the source's `@parameterRef` value object (none for a
//                zero-argument proc) and rows parsed by the entity module's Zod schema.
// customize:     which objects get a wrapper (the filter below), the file name and where
//                it lands. The module BODY comes from `renderCallableFile`, which `meta eject`
//                copies beside this file (`codegen/templates/callable-file.ts`): change the
//                emitted code there.
// composes-with: entity.ts (the wrapper imports the row schema and type it emits, and the
//                `@parameterRef` value object's interface).
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts` (the generator base, the
// model walks, the naming and type-mapping tables) and the code that writes the output from
// `../templates/`. `meta eject` copies those template modules into your project, under
// `codegen/templates/`, and your copy of this file imports them from there: they are yours too.

import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  perEntity,
  type Generator,
  type GeneratorFactory,
  formatTs,
  entityOutputPath,
  effectivePackage,
} from "@metaobjectsdev/codegen-ts";
import { isCallableEntity, renderCallableFile } from "../templates/callable-file.js";

export interface CallableFileOpts {
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export const callableFile = function callableFile(opts?: CallableFileOpts): Generator {
  const userFilter = opts?.filter;
  // OWNED: a vanilla table or view never emits a wrapper. A filter of your own narrows
  // further (it is ANDed), so it cannot make a non-callable object emit one.
  const filter: (e: MetaObject) => boolean = userFilter
    ? (e) => isCallableEntity(e) && userFilter(e)
    : isCallableEntity;

  const generator: Generator = {
    name: "callable-file",
    filter,
    generate: perEntity(async (entity, ctx) => {
      return {
        path: entityOutputPath(
          ctx.config.outputLayout ?? "flat",
          effectivePackage(entity),
          `${entity.name}.callable.ts`,
        ),
        content: await formatTs(renderCallableFile(entity, ctx.renderContext)),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<CallableFileOpts>;
