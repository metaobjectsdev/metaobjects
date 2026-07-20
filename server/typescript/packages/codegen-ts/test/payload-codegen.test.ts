import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { InMemoryStringSource } from "@metaobjectsdev/metadata";
import { generatePayloadInterfaces, generatePayloadInterfacesBatch, generateRenderHandle } from "../src/payload-codegen.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

/** Multi-file (multi-package) load — one source per (package, children) pair,
 *  merged into a single root. Mirrors fixtures/conformance/loader-same-name-distinct-packages
 *  and the render-helper-conformance xpkg-collision loader, for ADR-0044 collision tests. */
async function loadMultiPackageRoot(files: { package: string; children: unknown[] }[]) {
  const sources = files.map(
    (f) => new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: f.package, children: f.children } })),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors).toEqual([]);
  return res.root;
}

const model = [
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title", "@required": true } }] } },
  {
    "object.value": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName", "@required": true } },
        { "field.int": { name: "postCount", "@required": true } },
        {
          "field.object": {
            name: "posts",
            "isArray": true,
            "@objectRef": "PostBrief",
            "@required": true,
            children: [{ "origin.collection": { "@via": "Author.posts" } }],
          },
        },
      ],
    },
  },
  {
    "template.prompt": {
      name: "contentStrategyPrompt",
      "@payloadRef": "AuthorBrief",
      "@textRef": "prompt/strategy",
      "@format": "xml",
    },
  },
];

describe("payload-codegen — typed payload interface (types only, no class/VO)", () => {
  test("emits an interface with scalar + nested-array fields and the element interface", async () => {
    const root = await loadRoot(model);
    const out = generatePayloadInterfaces(root, "AuthorBrief", "acme::ai");
    expect(out).toContain("export interface AuthorBrief {");
    expect(out).toContain("displayName: string;");
    expect(out).toContain("postCount: number;");
    expect(out).toContain("posts: PostBrief[];");
    expect(out).toContain("export interface PostBrief {");
    expect(out).toContain("title: string;");
  });

  test("scalar isArray fields emit array TS types (string[], number[], boolean[])", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Lists",
          children: [
            { "field.string":  { name: "tags",     isArray: true, "@required": true } },
            { "field.int":     { name: "scores",   isArray: true, "@required": true } },
            { "field.boolean": { name: "flags",    isArray: true, "@required": true } },
            { "field.string":  { name: "solo",                    "@required": true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfaces(root, "Lists", "acme::ai");
    expect(out).toContain("tags: string[];");
    expect(out).toContain("scores: number[];");
    expect(out).toContain("flags: boolean[];");
    // Non-array scalars stay scalar.
    expect(out).toContain("solo: string;");
  });

  test("fields without required:true emit as optional + nullable (TS `?: T | null`)", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "MixedOptional",
          children: [
            { "field.string": { name: "mandatory", "@required": true } },
            { "field.string": { name: "discretionary" } },                  // implicit not-required
            { "field.string": { name: "explicitlyOptional", "@required": false } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfaces(root, "MixedOptional", "acme::ai");
    expect(out).toContain("mandatory: string;");
    expect(out).toContain("discretionary?: string | null;");
    expect(out).toContain("explicitlyOptional?: string | null;");
  });
});

describe("payload-codegen — generatePayloadInterfacesBatch", () => {
  test("returns empty string for empty input", async () => {
    const root = await loadRoot([
      { "object.value": { name: "X", children: [{ "field.string": { name: "y" } }] } },
    ]);
    expect(generatePayloadInterfacesBatch(root, [])).toBe("");
  });

  test("dedupes a nested type across multiple payloads", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Lens", children: [{ "field.string": { name: "id", "@required": true } }] } },
      {
        "object.value": {
          name: "A",
          children: [
            { "field.string": { name: "qa", "@required": true } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } },
          ],
        },
      },
      {
        "object.value": {
          name: "B",
          children: [
            { "field.string": { name: "qb", "@required": true } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfacesBatch(root, ["A", "B"], "acme::ai");
    const lensDeclarations = out.match(/export interface Lens \{/g);
    expect(lensDeclarations).toHaveLength(1);
    expect(out).toContain("export interface A {");
    expect(out).toContain("export interface B {");
    expect(out).toContain("items: Lens[];");
  });
});

describe("payload-codegen — FQN @objectRef (FR-032/ADR-0041) emits bare TS names", () => {
  // Regression: under package declaration, a nested @objectRef canonicalizes to an FQN
  // (`pkg::Name`). The emitter must strip the package for the emitted TS type AND the
  // generated interface name — an FQN contains `::`, which is invalid TypeScript. (The
  // 0.15.14 ADR-0041 fix extended FQN canonicalization into the payload tree but missed
  // promptRender's generated-type emission; this pins it.)
  test("a nested @objectRef given as an FQN emits a bare type + bare interface name (no `::`)", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Note", children: [{ "field.string": { name: "text", "@required": true } }] } },
      {
        "object.value": {
          name: "Report",
          children: [
            { "field.string": { name: "title", "@required": true } },
            { "field.object": { name: "notes", "@objectRef": "acme::ai::Note", isArray: true, "@required": true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfacesBatch(root, ["Report"], "acme::ai");
    // The defect emitted `notes: acme::ai::Note[];` and `export interface acme::ai::Note`.
    expect(out).not.toContain("::");
    expect(out).toContain("export interface Report {");
    expect(out).toContain("notes: Note[];");
    expect(out).toContain("export interface Note {");
    expect(out).toContain("text: string;");
  });
});

describe("payload-codegen — ADR-0044 no-churn (non-colliding output is byte-identical)", () => {
  // ADR-0044's central claim: a payload closure with NO short-name collision emits
  // BYTE-IDENTICAL output to before the FQN-keyed dedupe + collision-naming fix —
  // bare names, unchanged file layout. Full-string (toBe, not toContain) pins so any
  // stray whitespace/ordering churn from the pass 1/2/3 refactor would fail this.
  test("a non-colliding closure (root + nested ref) emits the exact pre-fix bare-name output", async () => {
    const root = await loadRoot([
      { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title", "@required": true } }] } },
      {
        "object.value": {
          name: "AuthorBrief",
          children: [
            { "field.string": { name: "displayName", "@required": true } },
            { "field.object": { name: "post", "@objectRef": "PostBrief", "@required": true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfaces(root, "AuthorBrief", "acme::ai");
    expect(out).toBe(
      "export interface AuthorBrief {\n" +
        "  displayName: string;\n" +
        "  post: PostBrief;\n" +
        "}\n\n" +
        "export interface PostBrief {\n" +
        "  title: string;\n" +
        "}\n",
    );
  });

  // Same claim through the batch entry point (generatePayloadInterfacesBatch),
  // which now shares ONE closure across all roots (ADR-0044) but must still emit
  // byte-identical output when nothing in that shared closure collides.
  test("a non-colliding batch (two roots sharing a nested ref) emits the exact pre-fix bare-name output", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Lens", children: [{ "field.string": { name: "id", "@required": true } }] } },
      {
        "object.value": {
          name: "A",
          children: [{ "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } }],
        },
      },
      {
        "object.value": {
          name: "B",
          children: [{ "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } }],
        },
      },
    ]);
    const out = generatePayloadInterfacesBatch(root, ["A", "B"], "acme::ai");
    expect(out).toBe(
      "export interface A {\n" +
        "  items: Lens[];\n" +
        "}\n\n" +
        "export interface Lens {\n" +
        "  id: string;\n" +
        "}\n\n" +
        "export interface B {\n" +
        "  items: Lens[];\n" +
        "}\n",
    );
  });
});

describe("payload-codegen — ADR-0044 cross-package short-name collision naming (#219/#220)", () => {
  // #219/#220: two packages each declare an object.value `Note` with DIFFERENT
  // fields; a third package's `Digest` references both by FULLY-QUALIFIED
  // @objectRef. Pre-ADR-0044 this dedup'd on the BARE name and silently dropped
  // betaText (first-wins). The fix must emit two DISTINCT types.
  async function loadCollidingNotes() {
    return loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "alphaText", "@required": true } }] } },
        ],
      },
      {
        package: "acme::beta",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "betaText", "@required": true } }] } },
        ],
      },
      {
        package: "acme::app",
        children: [
          {
            "object.value": {
              name: "Digest",
              children: [
                { "field.object": { name: "fromAlpha", "@objectRef": "acme::alpha::Note", "@required": true } },
                { "field.object": { name: "fromBeta", "@objectRef": "acme::beta::Note", "@required": true } },
              ],
            },
          },
        ],
      },
    ]);
  }

  test("emits TWO DISTINCT package-qualified types — not one merged/first-wins shape", async () => {
    const root = await loadCollidingNotes();
    const out = generatePayloadInterfaces(root, "acme::app::Digest");
    // Exact byte pin (not just toContain): proves ordering, field sets, and
    // both @required scalars survive untouched — Digest first (closure root),
    // then each colliding member under its PascalCase package-qualified name.
    expect(out).toBe(
      "export interface Digest {\n" +
        "  fromAlpha: AcmeAlphaNote;\n" +
        "  fromBeta: AcmeBetaNote;\n" +
        "}\n\n" +
        "export interface AcmeAlphaNote {\n" +
        "  alphaText: string;\n" +
        "}\n\n" +
        "export interface AcmeBetaNote {\n" +
        "  betaText: string;\n" +
        "}\n",
    );
    // Neither collision member survives as the bare, collision-losing "Note".
    expect(out).not.toContain("export interface Note {");
    // Exactly one declaration per emitted type — no clobbered/duplicate file-equivalent block.
    expect(out.match(/export interface AcmeAlphaNote \{/g)).toHaveLength(1);
    expect(out.match(/export interface AcmeBetaNote \{/g)).toHaveLength(1);
  });

  test("generateRenderHandle types the payload param under the SAME collision-aware name as the interfaces emitter", async () => {
    // A minimal template.output whose @payloadRef is the (non-colliding) Digest —
    // Digest's OWN closure collides on Note, but Digest itself is unique, so its
    // render-handle payload param stays bare "Digest" while the nested Notes
    // qualify. Uses acme::app so the bare @payloadRef resolves package-locally.
    const rootWithTemplate = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "alphaText", "@required": true } }] } },
        ],
      },
      {
        package: "acme::beta",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "betaText", "@required": true } }] } },
        ],
      },
      {
        package: "acme::app",
        children: [
          {
            "object.value": {
              name: "Digest",
              children: [
                { "field.object": { name: "fromAlpha", "@objectRef": "acme::alpha::Note", "@required": true } },
                { "field.object": { name: "fromBeta", "@objectRef": "acme::beta::Note", "@required": true } },
              ],
            },
          },
          {
            "template.output": {
              name: "DigestDoc",
              "@payloadRef": "acme::app::Digest",
              "@textRef": "xpkg/digest",
              "@format": "html",
            },
          },
        ],
      },
    ]);
    const handle = generateRenderHandle(rootWithTemplate, "DigestDoc");
    expect(handle).toContain("export function renderDigestDoc(payload: Digest, provider: Provider): string");
  });

  test("a still-colliding derived name FAILS LOUD with ERR_PAYLOAD_NAME_COLLISION (backstop)", async () => {
    // Pathological: "acme::alpha::Note" and "acmeAlpha::Note" both PascalCase-fold
    // to the SAME derived name "AcmeAlphaNote" — qualification cannot disambiguate.
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "a", "@required": true } }] } },
        ],
      },
      {
        package: "acmeAlpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "b", "@required": true } }] } },
        ],
      },
      {
        package: "acme::app",
        children: [
          {
            "object.value": {
              name: "Digest",
              children: [
                { "field.object": { name: "x", "@objectRef": "acme::alpha::Note", "@required": true } },
                { "field.object": { name: "y", "@objectRef": "acmeAlpha::Note", "@required": true } },
              ],
            },
          },
        ],
      },
    ]);
    expect(() => generatePayloadInterfaces(root, "acme::app::Digest")).toThrow(
      /ERR_PAYLOAD_NAME_COLLISION.*"AcmeAlphaNote".*derives from both.*"acme::alpha::Note".*"acmeAlpha::Note"/,
    );
  });
});

describe("payload-codegen — typed render handle", () => {
  test("emits a handle binding @textRef + @format and typing the payload", async () => {
    const root = await loadRoot(model);
    const out = generateRenderHandle(root, "contentStrategyPrompt");
    expect(out).toContain("export function renderContentStrategyPrompt(payload: AuthorBrief, provider: Provider): string");
    expect(out).toContain('ref: "prompt/strategy"');
    expect(out).toContain('format: "xml"');
    expect(out).toContain('from "@metaobjectsdev/render"');
  });
});
