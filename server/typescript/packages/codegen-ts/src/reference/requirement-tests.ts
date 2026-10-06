// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/requirement-tests.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { requirementTests } from "./codegen/generators/requirement-tests.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       bun:test. Each emitted stub imports `test` and `expect` from "bun:test"
//                and nothing from MetaObjects. For vitest, jest or node:test, change the
//                import line and the failing call in `renderRequirementTest` below.
// use-when:      the model declares `requirement.*` nodes and you want one test stub per
//                requirement the model claims. A live or partial requirement gets a stub
//                that FAILS until someone writes its assertion; a planned or retired one
//                gets a skipped stub.
// emits:         <target>/requirements/<path>.<concern>.test.ts for each requirement the
//                filter keeps, one per distinct `type.subType` it claims, and
//                <target>/requirements/<path>.test.ts when it claims nothing. Under
//                `grain: "member"` there is one stub per claimed reference instead.
// customize:     the stub text (`renderRequirementTest`, below, is the default renderer),
//                which requirements get a stub (`filter`), one stub per concern or one per
//                reference (`grain`), and where stubs land (`path`, together with `owns`).
//                What stays in the package is the walk, the grouping into tests, each
//                test's identity and the digest of a claim. Every language port agrees on
//                those, so replace them only if you mean to stop agreeing.
// composes-with: nothing. It reads the requirement ledger, not another generator's output.
//
// THE DIVISION OF LABOUR: the package owns the MECHANISM; this file is the POLICY, and it
// is yours. Which requirements get tests, at which levels, in what style, or none at all,
// is the application's decision. The filter IS the policy declaration, which is why there
// is no opt-out vocabulary: a requirement no generator matches expects no stub.
//
// Everything below imports ONLY from `@metaobjectsdev/codegen-ts` (the stable engine) and
// `@metaobjectsdev/metadata` (the named constants of the requirement vocabulary).

import {
  GENERATED_HEADER,
  NO_CONCERN,
  assertRequirementTestGrain,
  defaultRequirementTestFilter,
  requirementTestIdentity,
  requirementTestUnits,
  walkRequirements,
  type EmittedFile,
  type GenContext,
  type Generator,
  type RequirementTestArgs,
  type RequirementTestGrain,
  type RequirementTestRenderer,
  type RequirementView,
  type ResolvedClaim,
} from "@metaobjectsdev/codegen-ts";
import {
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_STATUSES,
  REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES,
  REQUIREMENT_STATUS_RETIRED,
} from "@metaobjectsdev/metadata";

// ---------------------------------------------------------------------------
// The default stub renderer.
//
// The package supplies DATA (statement, counterexample, status, claimed references, the
// test's identity and digest); a renderer supplies SYNTAX. This is the one you get when
// you register no renderer of your own, and the part of this file most worth editing.
//
// The load-bearing rule: an empty generated stub must NOT pass. A `live` entry claims the
// capability works, so an empty green test asserts the opposite of the claim.
// ---------------------------------------------------------------------------

/**
 * Statuses whose stub is SKIPPED rather than failing.
 *
 * The rule is "does this entry claim the capability works right now?" — only `live` and
 * `partial` do. A stub for anything else is skipped: a red build for something nobody
 * intends to build is noise an application silences wholesale, taking the live stubs
 * with it. Derived from the loader's status list, not restated from it, so a status
 * added later is skipped by construction instead of being left failing.
 */
const SKIPPED_STATUSES: ReadonlySet<string> = new Set(
  REQUIREMENT_STATUSES.filter((s) => !REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES.includes(s)),
);

/**
 * Escape an author-supplied value for a double-quoted TS string literal.
 *
 * Unescaped, a quote closes the literal and a newline breaks it, and the stub no longer
 * parses. Applied to EVERY value that reaches a literal, not only the two that are
 * obviously prose: the requirement path and the concern land in the same literals.
 */
function forStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Make an author-supplied value safe inside a JSDoc block, preserving what was written.
 *
 * A comment terminator would close the block early and spill the rest into code, so it
 * is split by a space (never deleted, and never by an invisible character); a newline
 * gets its own continuation marker. Every interpolated value goes through this,
 * `@trackedBy` included: it is free-form by design.
 */
function forDocComment(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/\r?\n/g, "\n * ");
}

function claimLines(targets: readonly ResolvedClaim[]): string {
  if (targets.length === 0) {
    return " *   (none — this requirement names no model nodes)";
  }
  return targets
    .map((t) => ` *   - ${forDocComment(t.ref)}  (${forDocComment(t.concern)})`)
    .join("\n");
}

function gapLine(a: RequirementTestArgs): string {
  const tracked = a.trackedBy ?? [];
  if (a.disposition === undefined && tracked.length === 0) return "";
  const decided = forDocComment(a.disposition ?? "undecided");
  const refs = tracked.length > 0 ? ` — ${tracked.map(forDocComment).join(", ")}` : "";
  return `\n *\n * Known gap: ${decided}${refs}`;
}

export function renderRequirementTest(a: RequirementTestArgs): string {
  // Decided from the requirement's STATUS. The identity fields on `a` (`skip`, `id`,
  // `digest`, …) are there for a renderer of your own; this one reads none of them.
  const skipped = a.view.status !== undefined && SKIPPED_STATUSES.has(a.view.status);
  const runner = skipped ? "test.skip" : "test";
  // The test NAME is the link between the ledger entry and the assertion, and it is a
  // string literal: an unescaped quote in either value closes it.
  const testName = `${forStringLiteral(a.view.path)} [${forStringLiteral(a.concern)}]`;

  // A live or partial stub asserts FAILURE until someone writes the real assertion over
  // it, and names the requirement in the message, so a red run says which claim is
  // unproven. The two skipped statuses mean OPPOSITE things and must not share a body:
  // `planned` is intended and not built yet; `retired` was built and deliberately
  // removed, and telling its reader to write the assertion "when this becomes live"
  // would instruct them to revive it.
  let body: string[];
  if (!skipped) {
    body = [
      "  expect.unreachable(",
      `    "unimplemented requirement stub: ${testName} — " +`,
      `    "replace this with an assertion that fails when: ${forStringLiteral(a.counterexample)}",`,
      "  );",
    ];
  } else if (a.view.status === REQUIREMENT_STATUS_RETIRED) {
    body = [
      "  // Retired: this capability was deliberately removed and must not be rebuilt.",
      "  // If you assert anything here, assert that it STAYS removed.",
    ];
  } else {
    body = ["  // Intended, not built. Write the assertion when this becomes live."];
  }

  // The header states the CONDITION on the survival promise, not just the promise: a
  // hand-written body is merged where this machine holds the file's snapshot, and the
  // file is refused (never overwritten) where it does not.
  const lines = [
    `// ${GENERATED_HEADER}.`,
    "// The test IDENTITY is generated from the requirement; the BODY below is yours.",
    "// Do not rename the test — the name is the link.",
    "// Your body is never overwritten: MERGED where .metaobjects/.gen-state/ holds this",
    "// file's snapshot body, REFUSED (run exits 1, body kept) where it does not. Those",
    "// bodies are gitignored, so a fresh clone or CI is always the second case — see",
    "// docs/features/own-your-codegen.md for the recovery.",
    'import { test, expect } from "bun:test";',
    "",
    "/**",
    ` * ${forDocComment(a.statement)}`,
    " *",
    ` * Counterexample: ${forDocComment(a.counterexample)}${gapLine(a)}`,
    " *",
    " * Claims:",
    claimLines(a.targets),
    " */",
    `${runner}("${testName}", () => {`,
    ...body,
    "});",
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------

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
   * Which emitted paths this generator is the sole producer of, so the runner may
   * remove a stub whose requirement was deleted. Given a path relative to this
   * generator's output directory, `/`-separated.
   *
   * Defaults to the directory `defaultPath` writes into. Supply this whenever you
   * supply `path`: the two describe the same namespace from opposite directions and
   * only you can keep them in agreement.
   */
  owns?: (relPathInTarget: string) => boolean;
  /** Delete a hand-edited orphan rather than refusing it. Default false. */
  forceOrphanDelete?: boolean;
  /** Turn orphan reconciliation off entirely. Default true — a stub whose requirement
   *  is gone is drift, and leaving it is how a deleted claim keeps a green test. */
  reconcileOrphans?: boolean;
}

/** How many uncovered requirements to name before "…and N more". */
const MAX_NAMED_UNCOVERED = 5;

/** The directory `defaultPath` writes into — and therefore the namespace the default
 *  policy claims. Kept beside it so the pair cannot drift. */
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
 * `::` is not a legal filename on every platform this output is checked out on.
 */
const defaultMemberPath = (view: RequirementView, ref: string): string =>
  defaultPath(view, ref === NO_CONCERN ? ref : ref.replace(/[^A-Za-z0-9]+/g, "_"));

/** Exact concern → `type.*` → `*` → the default renderer above. */
function pickRenderer(concern: string, opts: RequirementTestsOpts): RequirementTestRenderer {
  const viaFn = opts.resolveRenderer?.(concern);
  if (viaFn !== undefined) return viaFn;
  const map = opts.renderers ?? {};
  const typeOnly = `${concern.split(".")[0] ?? ""}.*`;
  return map[concern] ?? map[typeOnly] ?? map[NO_CONCERN] ?? renderRequirementTest;
}

// `attr()` RESOLVES in TypeScript, so a requirement that inherits its statement through
// `extends` renders what it effectively says.
function attrString(node: { attr: (n: string) => unknown }, name: string): string {
  const v = node.attr(name);
  return typeof v === "string" ? v : "";
}

export function requirementTests(opts: RequirementTestsOpts = {}): Generator {
  const filter = opts.filter ?? defaultRequirementTestFilter;
  const grain = opts.grain ?? "concern";
  // Refused here, when the generator is built, rather than on the first requirement:
  // an unknown grain is a mistake in the config whatever the model holds.
  assertRequirementTestGrain(grain);
  const toPath = opts.path ?? (grain === "member" ? defaultMemberPath : defaultPath);
  // A custom `path` with no custom `owns` leaves the default namespace pointing
  // somewhere the generator no longer writes, so reconciliation matches nothing. That
  // degrades safely — it can only ever delete less — but silently, hence the warning.
  const namespaceUnknown = opts.path !== undefined && opts.owns === undefined;

  const generator: Generator = {
    name: opts.name ?? "requirement-tests",
    generate: (ctx: GenContext): EmittedFile[] => {
      const files: EmittedFile[] = [];
      const uncovered: string[] = [];

      if (namespaceUnknown && opts.reconcileOrphans !== false) {
        ctx.warn(
          "a custom 'path' was supplied without a matching 'owns', so a stub left " +
            "behind by a deleted requirement will NOT be cleaned up. Supply 'owns' " +
            "to describe where 'path' writes, or set reconcileOrphans: false.",
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
          // the member grain the unit is a reference, and keying on it would match no
          // `type.subType` entry and silently retire every renderer you registered.
          const rendererKey = targets[0]?.concern ?? NO_CONCERN;
          files.push({
            path: toPath(walked.view, unit),
            content: pickRenderer(rendererKey, opts)(args),
          });
        }
      }

      // Policy living only in config means an uncovered requirement is indistinguishable
      // from a deliberate exclusion. One warning, never failing, and CAPPED: the default
      // filter excludes every architectural node and every L1-L3 functional one, so an
      // uncapped list buries the one actionable sentence under a wall of dotted paths.
      if ((opts.warnUncovered ?? true) && uncovered.length > 0) {
        const shown = uncovered.slice(0, MAX_NAMED_UNCOVERED).join(", ");
        const more =
          uncovered.length > MAX_NAMED_UNCOVERED
            ? `, and ${uncovered.length - MAX_NAMED_UNCOVERED} more`
            : "";
        ctx.warn(
          `${uncovered.length} requirement(s) matched no filter and get no stub. If that is deliberate, set warnUncovered: false to silence this. Uncovered: ${shown}${more}.`,
        );
      }

      return files;
    },
  };

  if (opts.target !== undefined) generator.target = opts.target;
  if (opts.reconcileOrphans !== false) {
    generator.orphanPolicy = {
      // With a custom `path` and no `owns`, claim NOTHING rather than guess: the default
      // namespace would be a claim over a directory this generator does not write to,
      // and a wrong claim deletes another generator's files.
      owns:
        opts.owns ??
        (namespaceUnknown ? () => false : (relPath) => relPath.startsWith(DEFAULT_STUB_DIR)),
      ...(opts.forceOrphanDelete === true && { force: true }),
    };
  }
  return generator;
}
