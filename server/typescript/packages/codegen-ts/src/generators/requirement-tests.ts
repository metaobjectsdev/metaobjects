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
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
} from "@metaobjectsdev/metadata";
import type { Generator, EmittedFile, GenContext } from "../generator.js";
import {
  walkRequirements,
  defaultRequirementTestFilter,
  requirementTestUnits,
  requirementTestIdentity,
  NO_CONCERN,
  type RequirementTestGrain,
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
  /**
   * What one stub stands for. `"concern"` (the default): one per distinct
   * `type.subType` a requirement claims. `"member"`: one per distinct `@implementedBy`
   * reference that resolves, for an application that wants a test per claimed node.
   */
  grain?: RequirementTestGrain;
  /** Renderer per concern key: exact `type.subType`, `type.*`, or `*`. In both grains
   *  the key is what the stub's target RESOLVES to, never the reference text. */
  renderers?: Record<string, RequirementTestRenderer>;
  /** Full control over renderer selection — beats `renderers` when it returns one. */
  resolveRenderer?: (concern: string) => RequirementTestRenderer | undefined;
  /** Where each stub lands. The second argument is the stub's fan-out key: the
   *  concern, or under `grain: "member"` the reference exactly as authored — which
   *  may hold `::`, so mangle it before it reaches a filename. */
  path?: (view: RequirementView, concern: string) => string;
  /** Named output target (registry key). */
  target?: string;
  /** Name requirements no filter covered. Default true; never fails the build. */
  warnUncovered?: boolean;
  /**
   * FR-038 §8 — which emitted paths this generator is the sole producer of, so
   * the runner may remove a stub whose requirement was deleted. Given a path
   * relative to this generator's output directory, `/`-separated.
   *
   * Defaults to the namespace `defaultPath` writes into. Supply this whenever you
   * supply `path`: the two describe the same namespace from opposite directions
   * and only you can keep them in agreement.
   */
  owns?: (relPathInTarget: string) => boolean;
  /**
   * Delete a hand-edited orphan rather than refusing it. Default false.
   *
   * A refusal already names the file and tells you the two ways out; this makes
   * the destructive one automatic. It exists so the decision is yours, not
   * because it is a good default.
   */
  forceOrphanDelete?: boolean;
  /** Turn orphan reconciliation off entirely. Default true — a stub whose
   *  requirement is gone is drift, and leaving it is how a deleted claim keeps a
   *  green test. */
  reconcileOrphans?: boolean;
}

/** How many uncovered requirements to name before "…and N more". Mirrors the
 *  runner's MAX_NAMED — the same cutoff, so every wall-avoiding message in the
 *  feature reads the same shape. */
const MAX_NAMED_UNCOVERED = 5;

/** The directory `defaultPath` writes into — and therefore the namespace the
 *  default policy claims. Kept beside it so the pair cannot drift. */
const DEFAULT_STUB_DIR = "requirements/";

const defaultPath = (view: RequirementView, concern: string): string =>
  concern === NO_CONCERN
    ? `${DEFAULT_STUB_DIR}${view.path}.test.ts`
    : `${DEFAULT_STUB_DIR}${view.path}.${concern}.test.ts`;

/**
 * The default path under `grain: "member"`, where the fan-out key is a reference.
 *
 * The reference is MANGLED into the last segment — every run of characters outside
 * `[A-Za-z0-9]` becomes one `_` — because a reference may be package-qualified and
 * `::` is not a legal filename on every platform this output is checked out on. The
 * concern grain keeps its unmangled segment: those paths are already in adopters'
 * repositories with hand-written bodies in them.
 */
const defaultMemberPath = (view: RequirementView, ref: string): string =>
  defaultPath(view, ref === NO_CONCERN ? ref : ref.replace(/[^A-Za-z0-9]+/g, "_"));

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
  const filter = opts.filter ?? defaultRequirementTestFilter;
  const grain = opts.grain ?? "concern";
  const toPath = opts.path ?? (grain === "member" ? defaultMemberPath : defaultPath);
  // A custom `path` with no custom `owns` leaves the default namespace pointing
  // somewhere the generator no longer writes, so reconciliation matches nothing.
  // That degrades safely — it can only ever delete less — but silently, and a
  // policy nobody can tell isn't running is the failure mode §5 is about.
  const namespaceUnknown = opts.path !== undefined && opts.owns === undefined;

  const generator: Generator = {
    name: opts.name ?? "requirement-tests",
    generate: (ctx: GenContext): EmittedFile[] => {
      const files: EmittedFile[] = [];
      const uncovered: string[] = [];

      if (namespaceUnknown && opts.reconcileOrphans !== false) {
        ctx.warn(
          `a custom 'path' was supplied without a matching 'owns', so a stub left ` +
            `behind by a deleted requirement will NOT be cleaned up. Supply 'owns' ` +
            `to describe where 'path' writes, or set reconcileOrphans: false.`,
        );
      }

      for (const walked of walkRequirements(ctx.loadedRoot)) {
        if (!filter(walked.view)) {
          uncovered.push(walked.view.path);
          continue;
        }
        for (const [unit, targets] of requirementTestUnits(walked, grain)) {
          const identity = requirementTestIdentity(walked, unit);
          const args: RequirementTestArgs = {
            view: walked.view,
            concern: unit,
            targets,
            statement: attrString(walked.node, REQUIREMENT_ATTR_STATEMENT),
            counterexample: attrString(walked.node, REQUIREMENT_ATTR_COUNTEREXAMPLE),
            disposition: walked.node.disposition(),
            trackedBy: walked.node.trackedBy(),
            package: identity.package,
            unit,
            id: identity.id,
            witnessKey: identity.witnessKey,
            skip: identity.skip,
            digest: identity.digest,
          };
          // The renderer is chosen by what the stub's target IS, in both grains. Under
          // the concern grain that is the unit itself; under the member grain the unit
          // is a reference, and keying on it would match no `type.subType` entry and
          // silently retire every renderer the application registered.
          const rendererKey = targets[0]?.concern ?? NO_CONCERN;
          files.push({
            path: toPath(walked.view, unit),
            content: pickRenderer(rendererKey, opts)(args),
          });
        }
      }

      // Policy living only in config means an uncovered requirement is
      // indistinguishable from a deliberate exclusion. One warning, never failing,
      // so "no tests here" is a visible choice rather than silence.
      if ((opts.warnUncovered ?? true) && uncovered.length > 0) {
        // CAPPED, matching the runner's refusal message. The default filter excludes
        // every architectural node and every L1-L3 functional one, so on the ledger
        // shapes this repo's own docs describe — dozens to hundreds of entries — an
        // uncapped list is a wall of dotted paths with the one actionable sentence
        // buried at the end of it. This is a generator meant to be the feature's first
        // contact; burying the opt-out is how it gets switched off wholesale.
        const shown = uncovered.slice(0, MAX_NAMED_UNCOVERED).join(", ");
        const more =
          uncovered.length > MAX_NAMED_UNCOVERED
            ? `, and ${uncovered.length - MAX_NAMED_UNCOVERED} more`
            : "";
        ctx.warn(
          `${uncovered.length} requirement(s) matched no filter and get no stub. ` +
            `If that is deliberate, set warnUncovered: false to silence this. ` +
            `Uncovered: ${shown}${more}.`,
        );
      }

      return files;
    },
  };

  if (opts.target !== undefined) generator.target = opts.target;
  if (opts.reconcileOrphans !== false) {
    generator.orphanPolicy = {
      // With a custom `path` and no `owns`, claim NOTHING rather than guess: the
      // default namespace would be a claim over a directory this generator does
      // not write to, and a wrong claim deletes another generator's files.
      owns: opts.owns ?? (namespaceUnknown
        ? () => false
        : (relPath) => relPath.startsWith(DEFAULT_STUB_DIR)),
      ...(opts.forceOrphanDelete === true && { force: true }),
    };
  }
  return generator;
}
