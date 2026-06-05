// Conformance + behavior check for the NEUTRAL template.output doc page
// (the "render contract" page). docsFile() — in addition to emitting one
// `<Entity>.md` per object — walks `template.output` nodes and emits one
// `<TemplateName>.md` per template (raw node name), visually/structurally
// DISTINCT from the entity page and with NO language assumptions.
//
// Covers:
//   1. Document template → WelcomePage.md (Kind/Output/Input/Render contract/
//      Source/Capability), payload link to ./Welcome.md, no language tokens.
//   2. Email template → WelcomeEmail.md (multipart parts table, 3 source refs,
//      email capability sentence).
//   3. Cross-link reconciliation: the entity page's `## Used by` link uses the
//      RAW template name (./WelcomeEmail.md), the template page links back with
//      the RAW payload name (./Welcome.md); both agree with the emitted files.
//   4. Neutrality: the template pages carry NONE of: a function signature,
//      `EmailDocument`, TS-type syntax, a language filename, or `Zod`.

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../../src/generators/docs-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/conformance");

function makeCtx(
  root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"],
  projectRoot?: string,
): GenContext {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext,
    warn: () => {},
    ...(projectRoot !== undefined && { projectRoot }),
  };
}

async function emitFixture(fixtureName: string) {
  const inputDir = join(CORPUS, fixtureName, "input");
  const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
  const sources = inputFiles.map((f) =>
    new InMemoryStringSource(readFileSync(join(inputDir, f), "utf-8"), { id: f, format: "json" }),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, `Fixture ${fixtureName} load errors`).toEqual([]);
  // projectRoot = the fixture's input/ dir, which carries a `templates/` folder
  // holding the referenced mustache sources — so the page's provider resolves
  // each @textRef / email part-ref to its real template source for the
  // "## Template source" section.
  const out = await docsFile().generate(makeCtx(res.root, inputDir));
  return out;
}

// Tokens that betray a language / SDK assumption — a template (render-contract)
// page MUST contain none of these.
const LANGUAGE_TOKENS = [
  "EmailDocument",
  "Zod",
  "): string",
  "): EmailDocument",
  "function render",
  ": string",
  ".ts",
  ".cs",
  ".kt",
  ".py",
];

function assertNeutral(content: string, label: string) {
  for (const tok of LANGUAGE_TOKENS) {
    // ".md" links are allowed; only flag the disallowed language filename exts.
    expect(content.includes(tok), `${label}: leaked language token "${tok}"`).toBe(false);
  }
}

describe("template.output doc page (render contract) — DOCUMENT", () => {
  it("emits WelcomePage.md with neutral render-contract sections", async () => {
    const out = await emitFixture("template-doc-document");
    const page = out.find((f) => f.path === "WelcomePage.md");
    expect(page, "missing WelcomePage.md").toBeDefined();
    const md = page!.content;

    expect(md).toContain("# WelcomePage");
    expect(md).toContain("**Kind:** document");
    expect(md).toContain("## Output");
    expect(md).toContain("- Format: `html`");
    expect(md).toContain("## Input");
    expect(md).toContain("- Payload: [`Welcome`](./Welcome.md)");
    expect(md).toContain("## Render contract");
    expect(md).toContain(
      "Every field referenced by the template is validated against the payload at generation time",
    );
    expect(md).toContain("Maximum length: 5000 characters");
    expect(md).toContain("## Source");
    expect(md).toContain("`site/welcome`");
    expect(md).toContain("## Capability");
    expect(md).toContain(
      "A render helper is generated for this template: it takes the payload and returns the rendered output as a single string.",
    );

    // Template source: the real mustache, a linked variables table, the rich view.
    expect(md).toContain("## Template source");
    // The verbatim fenced source of the resolved template.
    expect(md).toContain("```mustache");
    expect(md).toContain("<h1>Welcome, {{name}}!</h1>");
    // Variables table header + a linked field row using the shared field-<name> slug.
    expect(md).toContain("| Variable | Field | Type | Required |");
    expect(md).toContain("[Welcome.name](./Welcome.md#field-name)");
    expect(md).toContain("[Welcome.headline](./Welcome.md#field-headline)");
    // Rich linked <details> view.
    expect(md).toContain("<summary>Linked view</summary>");

    // Byte-identity against the regenerated golden.
    const golden = readFileSync(
      join(CORPUS, "template-doc-document", "expected", "WelcomePage.md"),
      "utf-8",
    );
    expect(md).toBe(golden);

    assertNeutral(md, "WelcomePage.md");
  });
});

describe("template.output doc page (render contract) — EMAIL", () => {
  it("emits WelcomeEmail.md with the multipart parts table + 3 source refs", async () => {
    const out = await emitFixture("template-doc-email");
    const page = out.find((f) => f.path === "WelcomeEmail.md");
    expect(page, "missing WelcomeEmail.md").toBeDefined();
    const md = page!.content;

    expect(md).toContain("# WelcomeEmail");
    expect(md).toContain("**Kind:** email");
    expect(md).toContain("Multipart email");
    // Parts table header.
    expect(md).toContain("| Part | Source | Format | Escaping |");
    // Subject = text / raw.
    expect(md).toContain("| Subject | `email/welcome.subject` | `text` | raw |");
    // HTML body = html / escaped.
    expect(md).toContain("| HTML body | `email/welcome.html` | `html` | escaped |");
    // Text body = text / raw.
    expect(md).toContain("| Text body | `email/welcome.text` | `text` | raw |");

    expect(md).toContain("- Payload: [`Welcome`](./Welcome.md)");

    // All 3 source refs present.
    expect(md).toContain("`email/welcome.subject`");
    expect(md).toContain("`email/welcome.html`");
    expect(md).toContain("`email/welcome.text`");

    expect(md).toContain("## Capability");
    expect(md).toContain(
      "A render helper is generated for this template: it takes the payload and returns the rendered email — subject, HTML body, and an optional text body.",
    );

    // Template source: one sub-section per email part, each with the real source.
    expect(md).toContain("## Template source");
    expect(md).toContain("### Subject");
    expect(md).toContain("### HTML body");
    expect(md).toContain("### Text body");
    expect(md).toContain("```mustache");
    expect(md).toContain("Welcome aboard, {{name}}!");
    expect(md).toContain("<h1>Welcome, {{name}}!</h1>");
    // Linked variables table per part, with field-<name> slug links.
    expect(md).toContain("[Welcome.name](./Welcome.md#field-name)");
    expect(md).toContain("[Welcome.headline](./Welcome.md#field-headline)");
    expect(md).toContain("<summary>Linked view</summary>");

    // Byte-identity against the regenerated golden.
    const golden = readFileSync(
      join(CORPUS, "template-doc-email", "expected", "WelcomeEmail.md"),
      "utf-8",
    );
    expect(md).toBe(golden);

    assertNeutral(md, "WelcomeEmail.md");
  });
});

describe("naming reconciliation — entity ↔ template cross-links use the RAW name", () => {
  it("entity Used-by href and template payload href agree (raw names)", async () => {
    const out = await emitFixture("template-doc-email");

    // Entity page for the payload VO.
    const entity = out.find((f) => f.path === "Welcome.md");
    expect(entity, "missing Welcome.md (entity page for payload VO)").toBeDefined();
    const entityMd = entity!.content;
    // Used-by link target must be the RAW template name.
    expect(entityMd).toContain("## Used by");
    expect(entityMd).toContain("](./WelcomeEmail.md)");

    // Template page links back to the payload entity by RAW name.
    const tmpl = out.find((f) => f.path === "WelcomeEmail.md");
    expect(tmpl!.content).toContain("(./Welcome.md)");

    // Both target files are actually emitted (links resolve).
    expect(out.find((f) => f.path === "WelcomeEmail.md")).toBeDefined();
    expect(out.find((f) => f.path === "Welcome.md")).toBeDefined();
  });
});
