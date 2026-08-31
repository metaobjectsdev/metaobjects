// AGENT_DOCS_BODY is retired. It was a 30KB single-blob agent reference that `meta init`
// stopped scaffolding when the agent-context assembler replaced it — but it stayed a
// public export of `@metaobjectsdev/sdk/agent-docs` and stayed advertised in this
// package's README as "the canonical agent reference docs (scaffolded by meta init)",
// which by then was false.
//
// It mattered because its CONTENT went on teaching what the loader rejects: `@label` on a
// view (unregistered — the subject of #353), a worked example on a `view.text-input`
// subtype that does not exist, `@placeholder`/`@helpText` as view attrs, `@message` on a
// validator.length, the split type/subtype key form the live always-on template forbids,
// and the claim that "sortability comes from the field's @sortable attr" (#352) which no
// generator implemented. Two of the four issues filed against 0.24.5 report exactly what
// this blob taught.
//
// Neither gate that exists for this could see it: the capability-grounding test scans the
// metaobjects-audit skill directory, and the shipped-example gate parses fenced blocks
// under docs/ and the skills. A published TypeScript string literal is in neither scope —
// which is why deleting it, rather than correcting it, is the fix. A second prompt surface
// that nothing scaffolds is a surface that drifts from the live one unobserved.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as agentDocs from "../src/agent-docs/index.js";

const SRC = join(import.meta.dir, "../src");
const README = join(import.meta.dir, "../README.md");

/** Every .ts file under src/, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("AGENT_DOCS_BODY is retired, not merely deprecated", () => {
  test("it is not a public export of @metaobjectsdev/sdk/agent-docs", () => {
    // An export is a promise of support — the same reasoning that removed EXTRA_SUFFIX
    // from codegen-ts in this release.
    expect(Object.keys(agentDocs)).not.toContain("AGENT_DOCS_BODY");
  });

  test("no source file defines or re-exports it", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);   // the walk must not silently yield []
    // Matches a declaration or a re-export, not a mention: the tombstone comment in
    // agent-docs/index.ts explaining WHY it went is the one reference worth keeping.
    const defines = /(export\s+(const|let|var)\s+AGENT_DOCS_BODY)|(export\s*\{[^}]*\bAGENT_DOCS_BODY\b)/;
    const carriers = files.filter((f) => defines.test(readFileSync(f, "utf8")));
    expect(carriers).toEqual([]);
  });

  test("the README no longer advertises it", () => {
    // It was sold as "the canonical agent reference docs (scaffolded by `meta init`)".
    // `meta init` scaffolds the agent-context; pointing a reader here sent them to prose
    // the toolchain had already contradicted.
    expect(readFileSync(README, "utf8")).not.toContain("AGENT_DOCS_BODY");
  });
});
