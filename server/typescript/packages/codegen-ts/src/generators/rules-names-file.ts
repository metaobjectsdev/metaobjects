import type { MetaData } from "@metaobjectsdev/metadata";
import { isMetaObject, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { packageToPath } from "../import-path.js";
import { NAMES_FILE_SUFFIX } from "../constants.js";
import { rulesNamesOf } from "../rules-walk.js";
import { renderRulesNames } from "../templates/rules-names.js";

/**
 * `rules.names.ts`: the rules names of one metadata package (ADR-0067 §1, layer 0) — its
 * lifecycles' states and transitions, its derived commands, its declared operations, and the
 * permissions and business errors they name — as constants a hand-written body, policy or
 * grant table imports instead of a string literal.
 *
 * The built-in twin of `src/reference/rules-names.ts` (ADR-0034 scaffold-and-own); the
 * reference-byte-identical gate holds the two to the same output.
 *
 * A SEPARATE generator, never a branch inside an existing one: a model with no rules vocabulary
 * gets no file from it, and no existing generator's output moves (`fixtures/codegen-noop/rules`).
 */
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
