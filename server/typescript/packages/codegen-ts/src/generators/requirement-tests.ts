// FR-038 §5/§6 — generate test stubs from `requirement.*` nodes.
//
// THE DIVISION OF LABOUR: this package owns the MECHANISM; the application owns
// the POLICY. Which requirements get tests, at which levels, in what style, or
// none at all, is the app's decision — the library ships defaults and
// recommendations, never rules.
//
// The filter IS the policy declaration, which is why there is no opt-out
// vocabulary: a requirement matched by no generator expects no stub by
// construction, so `verify --codegen` has nothing to drift against. An `@noTest`
// attribute would have to clear ADR-0023's can't-be-computed bar, and it cannot —
// the generator config already says it.
//
// Every default below has an override seam. The rule: if an application can hit a
// decision and cannot change it, that decision becomes a bug report against this
// package.

import {
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_VIOLATION,
} from "@metaobjectsdev/metadata";
import type { Generator, EmittedFile, GenContext } from "../generator.js";
import {
  walkRequirements,
  groupByConcern,
  NO_CONCERN,
  type RequirementView,
} from "../requirement-walk.js";
import {
  renderRequirementTest,
  type RequirementTestArgs,
} from "../templates/requirement-test.js";

export type RequirementTestRenderer = (a: RequirementTestArgs) => string;

export interface RequirementTestsOpts {
  /** Generator name — surfaces in diagnostics and drift logs. */
  name?: string;
  /** WHICH requirements get stubs. This is the app's policy declaration. */
  filter?: (r: RequirementView) => boolean;
  /** Renderer per concern key: exact `type.subType`, `type.*`, or `*`. */
  renderers?: Record<string, RequirementTestRenderer>;
  /** Full control over renderer selection — beats `renderers` when it returns one. */
  resolveRenderer?: (concern: string) => RequirementTestRenderer | undefined;
  /** Where each stub lands. */
  path?: (view: RequirementView, concern: string) => string;
  /** Named output target (registry key). */
  target?: string;
  /** Name requirements no filter covered. Default true; never fails the build. */
  warnUncovered?: boolean;
}

/**
 * RECOMMENDATION, not a rule: functional requirements at or below the link floor.
 *
 * Architectural requirements are excluded by default because `verify`'s
 * universality check already proves them structurally, so a test there is usually
 * redundant — usually, not never, which is exactly why this is overridable.
 */
const defaultFilter = (r: RequirementView): boolean =>
  r.subType === REQUIREMENT_SUBTYPE_FUNCTIONAL &&
  (r.level ?? 0) >= REQUIREMENT_LINK_FLOOR_LEVEL;

const defaultPath = (view: RequirementView, concern: string): string =>
  concern === NO_CONCERN
    ? `requirements/${view.path}.test.ts`
    : `requirements/${view.path}.${concern}.test.ts`;

/** Exact concern → `type.*` → `*` → the built-in renderer. */
function pickRenderer(
  concern: string,
  opts: RequirementTestsOpts,
): RequirementTestRenderer {
  const viaFn = opts.resolveRenderer?.(concern);
  if (viaFn !== undefined) return viaFn;
  const map = opts.renderers ?? {};
  const typeOnly = `${concern.split(".")[0] ?? ""}.*`;
  return map[concern] ?? map[typeOnly] ?? map[NO_CONCERN] ?? renderRequirementTest;
}

function attrString(node: { attr: (n: string) => unknown }, name: string): string {
  const v = node.attr(name);
  return typeof v === "string" ? v : "";
}

export function requirementTests(opts: RequirementTestsOpts = {}): Generator {
  const filter = opts.filter ?? defaultFilter;
  const toPath = opts.path ?? defaultPath;

  const generator: Generator = {
    name: opts.name ?? "requirement-tests",
    generate: (ctx: GenContext): EmittedFile[] => {
      const files: EmittedFile[] = [];
      const uncovered: string[] = [];

      for (const walked of walkRequirements(ctx.loadedRoot)) {
        if (!filter(walked.view)) {
          uncovered.push(walked.view.path);
          continue;
        }
        for (const [concern, targets] of groupByConcern(walked)) {
          const args: RequirementTestArgs = {
            view: walked.view,
            concern,
            targets,
            statement: attrString(walked.node, REQUIREMENT_ATTR_STATEMENT),
            violation: attrString(walked.node, REQUIREMENT_ATTR_VIOLATION),
            disposition: walked.node.disposition(),
            trackedBy: walked.node.trackedBy(),
          };
          files.push({
            path: toPath(walked.view, concern),
            content: pickRenderer(concern, opts)(args),
          });
        }
      }

      // Policy living only in config means an uncovered requirement is
      // indistinguishable from a deliberate exclusion. One warning, never failing,
      // so "no tests here" is a visible choice rather than silence.
      if ((opts.warnUncovered ?? true) && uncovered.length > 0) {
        ctx.warn(
          `requirement-tests: ${uncovered.length} requirement(s) matched no filter ` +
            `and get no stub: ${uncovered.join(", ")}. If that is deliberate, set ` +
            `warnUncovered: false to silence this.`,
        );
      }

      return files;
    },
  };

  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
