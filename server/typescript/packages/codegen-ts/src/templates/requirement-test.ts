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

/** Only `planned` is skipped — it is intended, not built, and reddening a build
 *  for something deliberately unbuilt is noise the app will silence wholesale. */
const STATUS_PLANNED = "planned";

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
  const skipped = a.view.status === STATUS_PLANNED;
  const runner = skipped ? "test.skip" : "test";

  // A `live` or `partial` stub asserts FAILURE until someone writes the real
  // assertion over it. `expect.unreachable` names the requirement in the failure
  // message, so a red run says which claim is unproven rather than just "failed".
  const body = skipped
    ? `  // Intended, not built. Write the assertion when this becomes live.`
    : `  expect.unreachable(\n` +
      `    "unimplemented requirement stub: ${a.view.path} [${a.concern}] — " +\n` +
      `    "replace this with an assertion that fails when: ${a.violation}",\n` +
      `  );`;

  return (
    `// ${GENERATED_HEADER}.\n` +
    `// The test IDENTITY is generated from the requirement; the BODY below is yours\n` +
    `// and survives regeneration. Do not rename the test — the name is the link.\n` +
    `import { test, expect } from "bun:test";\n` +
    `\n` +
    `/**\n` +
    ` * ${a.statement}\n` +
    ` *\n` +
    ` * Violated by: ${a.violation}${gapLine(a)}\n` +
    ` *\n` +
    ` * Claims:\n` +
    `${claimLines(a.targets)}\n` +
    ` */\n` +
    `${runner}("${a.view.path} [${a.concern}]", () => {\n` +
    `${body}\n` +
    `});\n`
  );
}
