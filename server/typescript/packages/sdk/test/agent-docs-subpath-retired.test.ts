// The `@metaobjectsdev/sdk/agent-docs` subpath is retired, and so is everything it held.
//
// It carried two things. `AGENT_DOCS_BODY` was the pre-agent-context single-blob agent
// reference: `meta init` stopped scaffolding it when the assembler replaced it — its own
// JSDoc said so — but it stayed exported and stayed advertised in this package's README as
// "the canonical agent reference docs (scaffolded by meta init)", which by then was false.
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
// which is why deleting it, rather than correcting it, was the fix. A second prompt surface
// that nothing scaffolds is a surface that drifts from the live one unobserved.
//
// The four content-hash helpers beside it went with the subpath. They were the pre-manifest
// way of telling a hand-edited scaffold from an untouched one; `agent-context/scaffold.ts`
// answers that with a per-file hash in the manifest, and nothing had imported them since.
// The live surface is `@metaobjectsdev/sdk/agent-context`.
//
// NOTE: the `meta agent-docs` COMMAND is unaffected and unrelated — it is the canonical
// scaffolder for every port. This is about a package subpath that shared its name.
import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "..");
const SRC = join(PKG_ROOT, "src");

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

describe("the agent-docs subpath is retired, not merely deprecated", () => {
  test("the package declares no ./agent-docs export", () => {
    // An export is a promise of support — the same reasoning that removed EXTRA_SUFFIX and
    // the CODEGEN_ATTR_EMIT_* constants from codegen-ts in this release.
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).not.toContain("./agent-docs");
    // The surface that replaced it must still be declared, or this test would pass on a
    // package that had lost both.
    expect(Object.keys(pkg.exports)).toContain("./agent-context");
  });

  test("the source directory is gone", () => {
    expect(existsSync(join(SRC, "agent-docs"))).toBe(false);
  });

  test("no source file defines or re-exports AGENT_DOCS_BODY", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);   // the walk must not silently yield []
    const defines = /(export\s+(const|let|var)\s+AGENT_DOCS_BODY)|(export\s*\{[^}]*\bAGENT_DOCS_BODY\b)/;
    expect(files.filter((f) => defines.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  test("the README advertises neither the blob nor the subpath", () => {
    // It was sold as "the canonical agent reference docs (scaffolded by `meta init`)".
    // `meta init` scaffolds the agent-context; pointing a reader here sent them to prose
    // the toolchain had already contradicted.
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme).not.toContain("AGENT_DOCS_BODY");
    expect(readme).not.toContain("sdk/agent-docs");
  });
});
