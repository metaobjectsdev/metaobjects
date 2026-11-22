// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/rules-names.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { rulesNamesFile } from "./codegen/generators/rules-names.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; use `node:` builtins instead.
// targets:       the emit step. Replace `renderRulesNames` to change the file's SHAPE (flat
//                `ORDER_STATUS_PLACED` constants, an enum per lifecycle); keep `rulesNamesOf`
//                so the names come from the same derivation `meta verify`'s rules gate checks.
// use-when:      hand-written code names a lifecycle state, a transition, a permission or a
//                business error (a command body, a policy, a grant table) and you want a rename
//                in the model to stop it compiling instead of leaving a stale string behind.
// emits:         <target>/<pkg path>/rules.names.ts per metadata package that declares a
//                lifecycle or an operation, in either output layout. A model with no rules
//                vocabulary gets no file.
// customize:     swap `renderRulesNames` for your own shape; keep `rulesNamesOf` as the one walk.
// composes-with: names.ts (the physical names of the same entities). Nothing else imports it.
//
// A SEPARATE generator, never a branch inside an existing one: a model with no rules vocabulary
// moves no existing generator's output (fixtures/codegen-noop/rules).
import {
  NAMES_FILE_SUFFIX,
  packageToPath,
  rulesNamesOf,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderRulesNames } from "../templates/rules-names.js";
import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";

export interface RulesNamesFileOpts {
  /** Narrow which entities' lifecycles and operations are written. ANDed with the generator's own
   *  gates, so it can only narrow; an operation with no target entity is always kept. */
  filter?: (entity: MetaObject) => boolean;
  /** Named output target, as on every other generator. */
  target?: string;
}

export function rulesNamesFile(opts?: RulesNamesFileOpts): Generator {
  const generator: Generator = {
    name: "rules-names",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj);
      return rulesNamesOf(ctx.loadedRoot, { matches }).map((pkg) => {
        // One file per PACKAGE, under the package's directory in either layout: under the flat
        // layout two packages would otherwise both write `rules.names.ts`. The `.names.ts`
        // suffix is what makes `meta verify --codegen` hold it fail-closed, like `<Entity>.names.ts`.
        const dir = packageToPath(pkg.package);
        const file = `rules${NAMES_FILE_SUFFIX}`;
        return { path: dir === "" ? file : `${dir}/${file}`, content: renderRulesNames(pkg) };
      });
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
