// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/barrel.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts instead of from the package:
//   import { barrel } from "./codegen/generators/barrel.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       nothing framework-specific — it re-exports whatever the other generators
//                emitted. `extStyle` decides whether the re-export specifiers carry a
//                `.js` extension.
// use-when:      you want a single `index.ts` re-exporting every generated entity module.
// emits:         <target>/index.ts with one `export * from "./<Entity>"` per entity, alphabetical.
// customize:     what to include/exclude here; the export form (star vs named), ordering and
//                grouping by package in the copied ../templates/barrel.ts (`renderBarrel`).
// composes-with: entity.ts (this re-exports the files entity.ts emits).
//
// The engine comes from `@metaobjectsdev/codegen-ts/engine`; the file body from
// ../templates/barrel.ts, which `meta eject` copies beside this file.

import {
  oncePerRun,
  type Generator,
  type GeneratorFactory,
  effectivePackage,
  claimBarrelNames,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderBarrel } from "../templates/barrel.js";

export interface BarrelOpts {
  target?: string;
}

export const barrel = function barrel(opts?: BarrelOpts): Generator {
  const generator: Generator = {
    name: "barrel",
    generate: oncePerRun(async (entities, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("barrel: renderContext is required (provided by runGen)");
      }
      const rc = ctx.renderContext;
      // Every name the barrel re-exports lives in its one namespace.
      for (const e of entities) claimBarrelNames(ctx, e);
      return {
        path: "index.ts",
        content: renderBarrel(
            entities.map((e) => ({ name: e.name, package: effectivePackage(e) })),
            rc.extStyle,
            rc.selfTarget,
            rc.entityModuleTarget,
          ),
      };
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<BarrelOpts>;
