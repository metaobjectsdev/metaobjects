// FR-038 §4 — the DEFAULT requirement-test renderer.
//
// "Default" is the operative word: an application owns its testing style, so this
// is what it gets when it registers no renderer of its own. The library supplies
// DATA (statement, violation, status, claimed refs); a renderer supplies SYNTAX.
// That separation is what keeps bun / vitest / jest / pytest / JUnit / xUnit from
// each being an upstream change to this package.
//
// The load-bearing rule: an empty generated stub must NOT pass. A `live` entry
// claims the capability works, so an empty green test asserts the opposite of the
// claim — the original defect recreated in a new place.

import { GENERATED_HEADER } from "../constants.js";
import type { RequirementView, ResolvedClaim } from "../requirement-walk.js";

export interface RequirementTestArgs {
  readonly view: RequirementView;
  readonly concern: string;
  readonly statement: string;
  readonly violation: string;
  readonly targets: readonly ResolvedClaim[];
  readonly disposition?: string | undefined;
  readonly trackedBy?: readonly string[] | undefined;
}

/**
 * Statuses whose stub is SKIPPED rather than failing.
 *
 * The rule is "does this entry claim the capability works right now?" — only `live`
 * and `partial` do. `planned` is intended-not-built; `abandoned` and `superseded`
 * describe a capability deliberately retired, whose `@implementedBy` is SUPPOSED to
 * dangle. Emitting a failing stub for any of the three reddens an application's suite
 * forever for something nobody intends to build, which is the noise an app silences
 * wholesale — taking the `live` stubs with it.
 *
 * (FR-038 §4 proposes retiring `abandoned`/`superseded` from the vocabulary entirely.
 * Until that breaking cut lands they are legal `@status` values, so the renderer has
 * to handle them.)
 */
const SKIPPED_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "abandoned",
  "superseded",
]);

/**
 * Escape author prose for a double-quoted TS string literal.
 *
 * `@statement` and `@violation` are free text. Unescaped, a quote closes the literal
 * and a newline breaks it — emitting a stub that does not parse, which `meta gen`
 * still reports as written because nothing here compiles it.
 */
function forStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * Make author prose safe inside a JSDoc block, preserving what was written.
 *
 * A comment-terminator in the prose would close the block early and spill the
 * remainder into code; a newline needs its own continuation marker or the block's
 * shape breaks. The terminator is separated by a space rather than deleted, so the
 * sentence still reads — and deliberately NOT by a zero-width space, which would keep
 * the text pixel-identical at the cost of putting an invisible character into
 * generated source that nobody can see when debugging it.
 */
function forDocComment(s: string): string {
  return s.replace(/\*\//g, "* /").replace(/\r?\n/g, "\n * ");
}

function claimLines(targets: readonly ResolvedClaim[]): string {
  if (targets.length === 0) {
    return " *   (none — this requirement names no model nodes)";
  }
  return targets.map((t) => ` *   - ${t.ref}  (${t.concern})`).join("\n");
}

function gapLine(a: RequirementTestArgs): string {
  const tracked = a.trackedBy ?? [];
  if (a.disposition === undefined && tracked.length === 0) return "";
  const decided = a.disposition ?? "undecided";
  const refs = tracked.length > 0 ? ` — ${tracked.join(", ")}` : "";
  return `\n *\n * Known gap: ${decided}${refs}`;
}

export function renderRequirementTest(a: RequirementTestArgs): string {
  const skipped = a.view.status !== undefined && SKIPPED_STATUSES.has(a.view.status);
  const statement = forDocComment(a.statement);
  const violation = forDocComment(a.violation);
  const runner = skipped ? "test.skip" : "test";

  // A `live` or `partial` stub asserts FAILURE until someone writes the real
  // assertion over it. `expect.unreachable` names the requirement in the failure
  // message, so a red run says which claim is unproven rather than just "failed".
  const body = skipped
    ? `  // Intended, not built. Write the assertion when this becomes live.`
    : `  expect.unreachable(\n` +
      `    "unimplemented requirement stub: ${a.view.path} [${a.concern}] — " +\n` +
      `    "replace this with an assertion that fails when: ${forStringLiteral(a.violation)}",\n` +
      `  );`;

  return (
    `// ${GENERATED_HEADER}.\n` +
    `// The test IDENTITY is generated from the requirement; the BODY below is yours\n` +
    `// and survives regeneration. Do not rename the test — the name is the link.\n` +
    `import { test, expect } from "bun:test";\n` +
    `\n` +
    `/**\n` +
    ` * ${statement}\n` +
    ` *\n` +
    ` * Violated by: ${violation}${gapLine(a)}\n` +
    ` *\n` +
    ` * Claims:\n` +
    `${claimLines(a.targets)}\n` +
    ` */\n` +
    `${runner}("${a.view.path} [${a.concern}]", () => {\n` +
    `${body}\n` +
    `});\n`
  );
}
