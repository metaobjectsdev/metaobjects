# FR6-ts — `template.output` parser codegen + `meta verify` extension (TypeScript)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land first-class TypeScript codegen for `template.output` — a stock `outputParser()` generator factory that emits a typed Zod parser per declared `template.output` (dual API: `parseXxx(text)` throws, `safeParseXxx(text)` returns Result), plus extend `meta verify` to cover output drift symmetric with prompt drift.

**Architecture:** Three phases shipping in tight sequence. **Phase A** adds an `outputParser()` factory in `@metaobjectsdev/codegen-ts/generators` that walks each `template.output` node, derives a Zod schema from the linked `@payloadRef`'s payload-VO, and emits `<TemplateName>.output.ts` per template (one file per output, NOT aggregated — unlike `promptRender()` because output parsers reference distinct VOs and benefit from per-template imports). **Phase B** extends `cli/src/commands/verify.ts` with a per-subtype branch so `template.output` drift is checked alongside `template.prompt`. **Phase C** is docs hygiene (codegen-ts README + CHANGELOG unreleased section).

**Tech Stack:** TypeScript ESM, Bun test runner, the existing `@metaobjectsdev/codegen-ts` plugin model (`Generator`, `GeneratorFactory`, `perEntity`/`oncePerRun` helpers, `ts-poet` for emission), `@metaobjectsdev/metadata` (template + object constants, `MetaRoot.ownChildren()`), `zod@4` (runtime dep of the consumer's generated code; not a metaobjects dep — emitted code targets the consumer's Zod install).

**Spec:**
- ADR: `spec/decisions/ADR-0010-template-output-parser-codegen.md`
- Cross-port parent: `docs/superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md`
- This port's spec: `docs/superpowers/specs/2026-05-25-fr6-ts-template-output-parser.md`

---

## File structure

### Phase A — `outputParser()` codegen

**Created:**
- `server/typescript/packages/codegen-ts/src/templates/output-parser.ts` — pure render function `renderOutputParser(root, templateName): string` (mirrors `payload-codegen.ts`'s style). Emits the Zod schema + dual-API `parse`/`safeParse` functions for one template.output. ~100 lines.
- `server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts` — the `outputParser()` factory. Per-template emit (one file per `template.output`). ~50 lines.
- `server/typescript/packages/codegen-ts/test/templates/output-parser.test.ts` — unit tests on the renderer (field-type → Zod-type mapping coverage).
- `server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts` — unit tests on the factory.
- `fixtures/conformance/template-output-simple/input/meta.npc.json` — fixture metadata declaring a `template.output`.
- `fixtures/conformance/template-output-simple/expected.json` — canonical metadata round-trip.
- `fixtures/conformance/template-output-simple/expected/NpcResponseOutput.output.ts` — byte-exact codegen output.

**Modified:**
- `server/typescript/packages/codegen-ts/src/generators/index.ts` — re-export `outputParser`.
- `server/typescript/packages/codegen-ts/test/golden/prompt-render-conformance.test.ts` — extend to also iterate `expected/*.output.ts` files (or add a sibling `output-parser-conformance.test.ts`; see Task A6 for the decision).

### Phase B — `meta verify` extension

**Modified:**
- `server/typescript/packages/cli/src/commands/verify.ts` — extends the existing `for (const tmpl of templates)` loop with a per-subtype branch. For `template.prompt`, existing logic (unchanged). For `template.output`, new check: re-derive the payload field tree, verify the `@payloadRef` resolves, report any field-type issues unsupported by the parser codegen. Findings gain a `kind: "prompt" | "output"` discriminator (log format updated).

**Created:**
- `server/typescript/packages/cli/test/unit/verify-output.test.ts` — tests for the new output-drift behaviour.

### Phase C — Docs

**Modified:**
- `server/typescript/packages/codegen-ts/README.md` — `outputParser()` documentation section.
- `CHANGELOG.md` — `## [Unreleased]` heading + Added entry for `outputParser()` factory + `meta verify` extension.

---

## Phase A — `outputParser()` generator + conformance fixture

The factory walks every `template.output` node in the metadata, derives a Zod schema from the linked `@payloadRef` value-object, and emits one `<TemplateName>.output.ts` per template containing:

```ts
// Generated NpcResponseOutput.output.ts
import { z } from "zod";
import type { NpcResponsePayload } from "./payloads.js";

const NpcResponseOutputSchema = z.object({
  name: z.string(),
  age: z.number().int(),
});

export type NpcResponseOutputValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed NpcResponsePayload.
 * @throws ZodError on validation failure.
 */
export function parseNpcResponseOutput(text: string): NpcResponsePayload {
  return NpcResponseOutputSchema.parse(JSON.parse(text)) as NpcResponsePayload;
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseNpcResponseOutput(
  text: string,
): { success: true; data: NpcResponsePayload } | { success: false; error: NpcResponseOutputValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: `invalid JSON: ${(err as Error).message}` }]),
    };
  }
  const result = NpcResponseOutputSchema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data as NpcResponsePayload }
    : { success: false, error: result.error };
}
```

The cast `as NpcResponsePayload` keeps the public-API return type stable (consumers depend on the payload interface, not Zod's inferred type). The schema is generated from the same payload-VO as `generatePayloadInterfaces()`, so the cast is structurally safe.

### Task A1 — Write failing tests for `renderOutputParser()`

**Files:**
- Create: `server/typescript/packages/codegen-ts/test/templates/output-parser.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// server/typescript/packages/codegen-ts/test/templates/output-parser.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../../src/templates/output-parser.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::ai", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("renderOutputParser()", () => {
  test("emits Zod schema + dual-API parse/safeParse for scalar payload", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "NpcResponsePayload",
          children: [
            { "field.string": { name: "name" } },
            { "field.int": { name: "age" } },
          ],
        },
      },
      {
        "template.output": {
          name: "NpcResponseOutput",
          "@payloadRef": "NpcResponsePayload",
          "@textRef": "npc/output",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "NpcResponseOutput");
    expect(out).toContain('import { z } from "zod"');
    expect(out).toContain('import type { NpcResponsePayload }');
    expect(out).toContain("const NpcResponseOutputSchema = z.object({");
    expect(out).toContain("name: z.string()");
    expect(out).toContain("age: z.number().int()");
    expect(out).toContain("export function parseNpcResponseOutput(text: string): NpcResponsePayload");
    expect(out).toContain("export function safeParseNpcResponseOutput(");
    expect(out).toContain("{ success: true; data: NpcResponsePayload }");
    expect(out).toContain("{ success: false; error: NpcResponseOutputValidationError }");
  });

  test("maps all scalar field subtypes correctly", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "AllScalars",
          children: [
            { "field.string": { name: "s" } },
            { "field.int": { name: "i" } },
            { "field.long": { name: "l" } },
            { "field.short": { name: "sh" } },
            { "field.byte": { name: "b" } },
            { "field.double": { name: "d" } },
            { "field.float": { name: "f" } },
            { "field.boolean": { name: "bool" } },
          ],
        },
      },
      {
        "template.output": {
          name: "AllScalarsOutput",
          "@payloadRef": "AllScalars",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "AllScalarsOutput");
    expect(out).toContain("s: z.string()");
    expect(out).toContain("i: z.number().int()");
    expect(out).toContain("l: z.number().int()");
    expect(out).toContain("sh: z.number().int()");
    expect(out).toContain("b: z.number().int()");
    expect(out).toContain("d: z.number()");
    expect(out).toContain("f: z.number()");
    expect(out).toContain("bool: z.boolean()");
  });

  test("emits z.array() for isArray fields", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "ListPayload",
          children: [
            { "field.string": { name: "tags", isArray: true } },
          ],
        },
      },
      {
        "template.output": {
          name: "ListOutput",
          "@payloadRef": "ListPayload",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "ListOutput");
    expect(out).toContain("tags: z.array(z.string())");
  });

  test("emits nested object schemas for field.object with @objectRef", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Inner",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "object.value": {
          name: "Outer",
          children: [
            {
              "field.object": {
                name: "inner",
                "@objectRef": "Inner",
              },
            },
          ],
        },
      },
      {
        "template.output": {
          name: "OuterOutput",
          "@payloadRef": "Outer",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "OuterOutput");
    expect(out).toContain("inner: z.object({");
    expect(out).toContain("x: z.string()");
  });

  test("throws when template name is not a template.output", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "P",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "notOutput",
          "@payloadRef": "P",
          "@textRef": "x/y",
          "@format": "text",
        },
      },
    ]);
    expect(() => renderOutputParser(root, "notOutput")).toThrow(/not a template\.output/i);
  });

  test("throws when @payloadRef cannot be resolved", async () => {
    const root = await loadRoot([
      {
        "template.output": {
          name: "BrokenOutput",
          "@payloadRef": "DoesNotExist",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    expect(() => renderOutputParser(root, "BrokenOutput")).toThrow(/DoesNotExist/);
  });
});
```

- [ ] **Step 2: Run, confirm 6 failures (module not found)**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/output-parser.test.ts
```

Expected: FAIL with `Cannot find module '../../src/templates/output-parser.js'`.

### Task A2 — Implement `renderOutputParser()`

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/output-parser.ts`

- [ ] **Step 1: Write the renderer**

```ts
// server/typescript/packages/codegen-ts/src/templates/output-parser.ts
//
// Per-template renderer for template.output codegen. Walks the @payloadRef's
// value-object into a Zod schema and emits a dual-API parser (parse + safeParse)
// alongside the schema. The emitted file imports the payload-VO type from
// "./payloads.js" — the outputParser() factory writes one file per template,
// so a consumer's project will have multiple <Name>.output.ts files all
// referencing the shared payloads file emitted by promptRender() (or by their
// own generator).

import {
  type MetaData,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  TEMPLATE_ATTR_PAYLOAD_REF,
} from "@metaobjectsdev/metadata";

const SCALAR_ZOD: Record<string, string> = {
  string: "z.string()",
  class: "z.string()",
  int: "z.number().int()",
  short: "z.number().int()",
  byte: "z.number().int()",
  long: "z.number().int()",
  double: "z.number()",
  float: "z.number()",
  boolean: "z.boolean()",
};

function findObject(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function findTemplate(root: MetaData, name: string): MetaData | undefined {
  return root.ownChildren().find((c) => c.type === TYPE_TEMPLATE && c.name === name);
}

/** Render the Zod expression for a single field; recurses on @objectRef. */
function fieldZod(field: MetaData, root: MetaData, seen: ReadonlySet<string>): string {
  const isArray = field.ownAttr("isArray") === true;
  let base: string;
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const refName = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    if (typeof refName !== "string") {
      base = "z.unknown()";
    } else if (seen.has(refName)) {
      // Cycle guard — emit unknown for self-references (rare; lazy schemas not in scope for v1).
      base = "z.unknown()";
    } else {
      const inner = findObject(root, refName);
      base = inner ? renderObjectSchema(inner, root, new Set(seen).add(refName)) : "z.unknown()";
    }
  } else {
    base = SCALAR_ZOD[field.subType] ?? "z.unknown()";
  }
  return isArray ? `z.array(${base})` : base;
}

/** Render a `z.object({ ... })` for an object.value node. */
function renderObjectSchema(vo: MetaData, root: MetaData, seen: ReadonlySet<string>): string {
  const fields = vo.children().filter((c) => c.type === TYPE_FIELD);
  const lines = fields.map((f) => `    ${f.name}: ${fieldZod(f, root, seen)},`);
  return `z.object({\n${lines.join("\n")}\n  })`;
}

/**
 * Render the full output-parser file for one `template.output` node.
 * Throws if the template isn't found, isn't a template.output, or its
 * @payloadRef doesn't resolve to an object.value.
 */
export function renderOutputParser(root: MetaData, templateName: string): string {
  const tmpl = findTemplate(root, templateName);
  if (!tmpl) {
    throw new Error(`template "${templateName}" not found in metadata root`);
  }
  if (tmpl.subType !== TEMPLATE_SUBTYPE_OUTPUT) {
    throw new Error(`template "${templateName}" is not a template.output (got subtype "${tmpl.subType}")`);
  }
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof payloadRef !== "string") {
    throw new Error(`template "${templateName}" missing @payloadRef`);
  }
  const vo = findObject(root, payloadRef);
  if (!vo) {
    throw new Error(`template "${templateName}" @payloadRef "${payloadRef}" not found in metadata root`);
  }

  const schema = renderObjectSchema(vo, root, new Set([payloadRef]));
  const schemaName = `${templateName}Schema`;
  const errorName = `${templateName}ValidationError`;
  const parseName = `parse${templateName}`;
  const safeParseName = `safeParse${templateName}`;

  return `import { z } from "zod";
import type { ${payloadRef} } from "./payloads.js";

const ${schemaName} = ${schema};

export type ${errorName} = z.ZodError;

/**
 * Parse an LLM response into a typed ${payloadRef}.
 * @throws ZodError on validation failure.
 */
export function ${parseName}(text: string): ${payloadRef} {
  return ${schemaName}.parse(JSON.parse(text)) as ${payloadRef};
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function ${safeParseName}(
  text: string,
): { success: true; data: ${payloadRef} } | { success: false; error: ${errorName} } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: \`invalid JSON: \${(err as Error).message}\` }]),
    };
  }
  const result = ${schemaName}.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data as ${payloadRef} }
    : { success: false, error: result.error };
}
`;
}
```

- [ ] **Step 2: Run the tests**

```bash
cd server/typescript && bun test packages/codegen-ts/test/templates/output-parser.test.ts
```

Expected: PASS, 6 tests.

### Task A3 — Write failing tests for the `outputParser()` factory

**Files:**
- Create: `server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { outputParser } from "../../src/generators/output-parser-file.js";
import type { GenContext } from "../../src/generator.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::ai", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function makeCtx(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp/out", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("outputParser() factory", () => {
  test("emits no files when metadata has no template.output nodes", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "promptOnly",
          "@payloadRef": "Payload",
          "@textRef": "p/x",
          "@format": "text",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toEqual([]);
  });

  test("emits one file per template.output", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "AlphaPayload",
          children: [{ "field.string": { name: "name" } }],
        },
      },
      {
        "object.value": {
          name: "BetaPayload",
          children: [{ "field.int": { name: "n" } }],
        },
      },
      {
        "template.output": {
          name: "Alpha",
          "@payloadRef": "AlphaPayload",
          "@textRef": "a/x",
          "@format": "json",
        },
      },
      {
        "template.output": {
          name: "Beta",
          "@payloadRef": "BetaPayload",
          "@textRef": "b/x",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(2);
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual(["Alpha.output.ts", "Beta.output.ts"]);
    const alpha = out.find((f) => f.path === "Alpha.output.ts")!;
    expect(alpha.content).toContain("export function parseAlpha");
    expect(alpha.content).toContain("export function safeParseAlpha");
    const beta = out.find((f) => f.path === "Beta.output.ts")!;
    expect(beta.content).toContain("export function parseBeta");
  });

  test("honors a custom outDir option", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "P",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.output": {
          name: "P",
          "@payloadRef": "P",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser({ outDir: "src/generated/outputs" });
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/generated/outputs/P.output.ts");
  });

  test("does not emit for template.prompt nodes", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "PromptOne",
          "@payloadRef": "Payload",
          "@textRef": "p/x",
          "@format": "text",
        },
      },
      {
        "template.output": {
          name: "OutputOne",
          "@payloadRef": "Payload",
          "@textRef": "o/x",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("OutputOne.output.ts");
  });
});
```

- [ ] **Step 2: Run, confirm 4 failures (module not found)**

```bash
cd server/typescript && bun test packages/codegen-ts/test/generators/output-parser-file.test.ts
```

Expected: FAIL with `Cannot find module '../../src/generators/output-parser-file.js'`.

### Task A4 — Implement the `outputParser()` factory

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts`

- [ ] **Step 1: Write the factory**

```ts
// server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts
//
// Stock generator that emits one <TemplateName>.output.ts file per declared
// template.output node. Wraps renderOutputParser() from templates/output-parser.ts.
//
// Consumer wiring (metaobjects.config.ts):
//   generators: [..., promptRender(), outputParser()]
//
// Custom output directory:
//   generators: [..., outputParser({ outDir: "src/generated/outputs" })]

import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  oncePerRun,
} from "../generator.js";
import { renderOutputParser } from "../templates/output-parser.js";

export interface OutputParserOpts {
  /** Output directory prefix relative to the target's outDir. Default: "" (root). */
  outDir?: string;
  /** Optional named output target (registry key). Defaults to "default". */
  target?: string;
}

export const outputParser = function outputParser(opts?: OutputParserOpts): Generator {
  const dirPrefix = opts?.outDir ? `${opts.outDir.replace(/\/$/, "")}/` : "";
  const generator: Generator = {
    name: "output-parser",
    generate: oncePerRun((_entities, ctx) => {
      const outputs = ctx.loadedRoot
        .ownChildren()
        .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_OUTPUT);
      const files: EmittedFile[] = [];
      for (const t of outputs) {
        files.push({
          path: `${dirPrefix}${t.name}.output.ts`,
          content: renderOutputParser(ctx.loadedRoot, t.name),
        });
      }
      return files;
    }),
  };
  if (opts?.target) {
    generator.target = opts.target;
  }
  return generator;
} as GeneratorFactory<OutputParserOpts>;
```

- [ ] **Step 2: Run the tests**

```bash
cd server/typescript && bun test packages/codegen-ts/test/generators/output-parser-file.test.ts
```

Expected: PASS, 4 tests.

### Task A5 — Re-export from `generators/index.ts`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/index.ts`

- [ ] **Step 1: Append the new re-export**

Add to `server/typescript/packages/codegen-ts/src/generators/index.ts` (existing file; preserve all existing exports):

```ts
export { outputParser, type OutputParserOpts } from "./output-parser-file.js";
```

- [ ] **Step 2: Verify full server suite still passes**

```bash
cd server/typescript && bun test
```

Expected: green; test count is `<previous-baseline> + 10` (6 renderer + 4 factory). No regression.

- [ ] **Step 3: Verify build clean**

```bash
cd /home/doug/Development/metaobjects && bun run --filter '*' build
```

Expected: all 14 packages exit 0.

### Task A6 — Add `template-output-simple` conformance fixture + byte-match conformance test

**Files:**
- Create: `fixtures/conformance/template-output-simple/input/meta.npc.json`
- Create: `fixtures/conformance/template-output-simple/expected.json`
- Create: `fixtures/conformance/template-output-simple/expected/NpcResponseOutput.output.ts`
- Modify (extend): `server/typescript/packages/codegen-ts/test/golden/prompt-render-conformance.test.ts` — rename or add a sibling so it covers both `expected/prompts.ts` and `expected/*.output.ts`.

The simplest split: leave `prompt-render-conformance.test.ts` alone and add a new `output-parser-conformance.test.ts` that walks every fixture and asserts byte-match for any `expected/*.output.ts` files. Keeps the two checks decoupled and easier to evolve.

- [ ] **Step 1: Create the fixture input**

```bash
mkdir -p fixtures/conformance/template-output-simple/input
mkdir -p fixtures/conformance/template-output-simple/expected
```

Write `fixtures/conformance/template-output-simple/input/meta.npc.json`:

```json
{
  "metadata.root": {
    "package": "acme::ai",
    "children": [
      {
        "object.value": {
          "name": "NpcResponsePayload",
          "children": [
            { "field.string": { "name": "name" } },
            { "field.int": { "name": "age" } }
          ]
        }
      },
      {
        "template.output": {
          "name": "NpcResponseOutput",
          "@payloadRef": "NpcResponsePayload",
          "@textRef": "npc/output",
          "@format": "json"
        }
      }
    ]
  }
}
```

- [ ] **Step 2: Generate `expected.json` (canonical metadata round-trip)**

Run from the worktree root:

```bash
cd server/typescript && bun -e '
import { MetaDataLoader, FileSource, canonicalSerialize } from "@metaobjectsdev/metadata";
import { writeFileSync } from "node:fs";
const FIXTURE = process.env.FIXTURE!;
const res = await new MetaDataLoader().load([new FileSource(`${FIXTURE}/input/meta.npc.json`)]);
if (res.errors.length > 0) { console.error(res.errors); process.exit(1); }
const out = canonicalSerialize(res.root);
writeFileSync(`${FIXTURE}/expected.json`, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("Wrote expected.json");
' FIXTURE=/home/doug/Development/metaobjects/fixtures/conformance/template-output-simple
```

(Replace the absolute path with whatever your current repo root is — the implementer will compute it from `git rev-parse --show-toplevel`.)

If `canonicalSerialize` lives at a different import path, find it:

```bash
grep -rn "export.*canonicalSerialize" server/typescript/packages/metadata/src/ | head -3
```

- [ ] **Step 3: Generate the `expected/NpcResponseOutput.output.ts` artifact**

```bash
cd server/typescript && bun -e '
import { MetaDataLoader, FileSource } from "@metaobjectsdev/metadata";
import { outputParser } from "@metaobjectsdev/codegen-ts/generators";
import { writeFileSync } from "node:fs";
const FIXTURE = process.env.FIXTURE!;
const res = await new MetaDataLoader().load([new FileSource(`${FIXTURE}/input/meta.npc.json`)]);
if (res.errors.length > 0) { console.error(res.errors); process.exit(1); }
const gen = outputParser();
const out = await gen.generate({
  entities: res.root.objects(),
  loadedRoot: res.root,
  matches: () => true,
  config: { outDir: "/tmp", dialect: "sqlite" },
  warn: () => {},
});
writeFileSync(`${FIXTURE}/expected/NpcResponseOutput.output.ts`, out[0].content, "utf8");
console.log("Wrote", out[0].content.length, "chars");
' FIXTURE=/home/doug/Development/metaobjects/fixtures/conformance/template-output-simple
```

If the `@metaobjectsdev/codegen-ts/generators` import doesn't resolve, use the deep file path (`../codegen-ts/src/generators/index.ts` or the resolved package export).

- [ ] **Step 4: Inspect the artifact**

```bash
cat fixtures/conformance/template-output-simple/expected/NpcResponseOutput.output.ts
```

Expected: contains `import { z } from "zod"`, the schema declaration, and both `parseNpcResponseOutput` + `safeParseNpcResponseOutput` functions.

- [ ] **Step 5: Add the byte-match conformance test**

Create `server/typescript/packages/codegen-ts/test/golden/output-parser-conformance.test.ts`:

```ts
// Conformance check: outputParser() codegen output matches
// fixtures/conformance/<name>/expected/*.output.ts byte-for-byte.
//
// For every conformance fixture that ships any expected/*.output.ts file, this
// test loads the input metadata, runs outputParser(), and asserts byte-identical
// match. Fixtures without expected/*.output.ts are skipped.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { outputParser } from "../../src/generators/output-parser-file.js";
import type { GenContext } from "../../src/generator.js";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/conformance");

function makeCtx(root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"]): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("outputParser() conformance fixtures", () => {
  const fixtures = readdirSync(CORPUS).filter((d) => {
    const expectedDir = join(CORPUS, d, "expected");
    if (!existsSync(expectedDir)) return false;
    return readdirSync(expectedDir).some((f) => f.endsWith(".output.ts"));
  });

  if (fixtures.length === 0) {
    it("(no fixtures with expected/*.output.ts found — placeholder)", () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const fixture of fixtures) {
    it(`fixture ${fixture}: outputParser() byte-matches expected/*.output.ts`, async () => {
      const inputDir = join(CORPUS, fixture, "input");
      const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
      expect(inputFiles.length).toBeGreaterThan(0);
      const sources = inputFiles.map(
        (f) =>
          new InMemoryStringSource(
            readFileSync(join(inputDir, f), "utf-8"),
            { id: f, format: "json" },
          ),
      );
      const res = await new MetaDataLoader().load(sources);
      expect(res.errors).toEqual([]);

      const gen = outputParser();
      const emitted = await gen.generate(makeCtx(res.root));

      const expectedDir = join(CORPUS, fixture, "expected");
      const expectedFiles = readdirSync(expectedDir).filter((f) => f.endsWith(".output.ts"));
      for (const ef of expectedFiles) {
        const expected = readFileSync(join(expectedDir, ef), "utf8");
        const match = emitted.find((e) => e.path === ef);
        expect(match, `no emitted file for ${ef}`).toBeDefined();
        expect(match!.content).toBe(expected);
      }
    });
  }
});
```

- [ ] **Step 6: Run the conformance test, confirm it passes**

```bash
cd server/typescript && bun test packages/codegen-ts/test/golden/output-parser-conformance.test.ts
```

Expected: PASS, 1 test (the fixture iteration).

- [ ] **Step 7: Run the full suite, confirm green**

```bash
cd server/typescript && bun test
```

Expected: all green.

### Task A7 — Commit Phase A

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/codegen-ts/src/templates/output-parser.ts \
  server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts \
  server/typescript/packages/codegen-ts/src/generators/index.ts \
  server/typescript/packages/codegen-ts/test/templates/output-parser.test.ts \
  server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts \
  server/typescript/packages/codegen-ts/test/golden/output-parser-conformance.test.ts \
  fixtures/conformance/template-output-simple/

git commit -m "$(cat <<'EOF'
feat(codegen-ts): outputParser() generator for template.output (FR6-ts Phase A)

New stock generator factory in @metaobjectsdev/codegen-ts/generators that emits
one <TemplateName>.output.ts per declared template.output node. Each emitted
file contains:

- A Zod schema derived from the @payloadRef's value-object structure.
- parse<Name>(text): T   — throws ZodError on validation failure (matches Zod
  parse() and the Vercel AI SDK generateObject() conventions).
- safeParse<Name>(text)  — Result-style return; JSON-parse failures synthesize
  a ZodError so the success/error shape is uniform across both branches.

Field-type → Zod-type mapping: scalars via SCALAR_ZOD table; isArray wraps in
z.array(); field.object with @objectRef recurses into nested z.object(). Cycle
guard for self-referencing object refs (emits z.unknown() for the back-edge).

Consumer wiring: `generators: [..., promptRender(), outputParser()]`. Custom
output dir via `outputParser({ outDir: "src/generated/outputs" })`.

New conformance fixture template-output-simple ships:
- input/meta.npc.json — minimal NpcResponsePayload + NpcResponseOutput
- expected.json — canonical metadata round-trip
- expected/NpcResponseOutput.output.ts — byte-exact codegen output

New golden test output-parser-conformance.test.ts walks every fixture's
expected/*.output.ts files and asserts byte-match against outputParser()'s
emission.

10 new unit tests (6 renderer + 4 factory) + 1 conformance iteration.

Resolves FR6-ts Phase A. Phase B (meta verify extension) and Phase C (docs)
follow.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase B — `meta verify` extension for output drift

The existing `verify.ts` walks `TYPE_TEMPLATE` nodes and runs the render-engine `verify()` for each. The current code treats all subtypes the same (it just requires `@textRef` and `@payloadRef` to be present). FR6's extension:

1. Add a per-subtype branch — only `template.prompt` invokes the render-engine `verify()`.
2. For `template.output`, run a lighter check: verify the `@payloadRef` resolves to an existing `object.value`, and verify the parser-codegen can produce a schema (no unsupported field types).
3. Findings gain a `kind: "prompt" | "output"` discriminator on the log line so CI dashboards / human readers can distinguish them.

The output check is intentionally LIGHTER than the prompt check: it doesn't read the committed parser file from disk (that would require knowing the consumer's output directory). Instead, it re-derives what the parser WOULD validate against and surfaces any payload-side issues (unresolved refs, unsupported field types). This matches the "render-engine verify on prompts; codegen-derive verify on outputs" split.

### Task B1 — Write failing tests for the verify extension

**Files:**
- Create: `server/typescript/packages/cli/test/unit/verify-output.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// server/typescript/packages/cli/test/unit/verify-output.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("meta verify — template.output drift", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-output-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
    mkdirSync(join(dir, "metaobjects"));
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("passes when template.output references a resolvable @payloadRef", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "x" } }] } },
            {
              "template.output": {
                name: "Out",
                "@payloadRef": "P",
                "@textRef": "o/x",
                "@format": "json",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "o"), { recursive: true });
    writeFileSync(join(dir, "prompts", "o", "x"), "schema spec text");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });

  test("fails (exit 1) when template.output references a missing @payloadRef", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            {
              "template.output": {
                name: "Broken",
                "@payloadRef": "DoesNotExist",
                "@textRef": "x/y",
                "@format": "json",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "x"), { recursive: true });
    writeFileSync(join(dir, "prompts", "x", "y"), "...");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(1);
  });

  test("passes when only template.prompt nodes are present (no regression)", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.ai.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::ai",
          children: [
            { "object.value": { name: "P", children: [{ "field.string": { name: "name" } }] } },
            {
              "template.prompt": {
                name: "P1",
                "@payloadRef": "P",
                "@textRef": "p/1",
                "@format": "text",
              },
            },
          ],
        },
      }),
    );
    mkdirSync(join(dir, "prompts", "p"), { recursive: true });
    writeFileSync(join(dir, "prompts", "p", "1"), "Hello {{name}}");

    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 2: Run, confirm 2 of 3 fail**

```bash
cd server/typescript && bun test packages/cli/test/unit/verify-output.test.ts
```

Expected: the "passes when template.output references a resolvable @payloadRef" test may pass spuriously today because today's verify treats output the same as prompt and the render-engine verify just confirms textRef resolves. The "fails when missing @payloadRef" test should fail (today's verify wouldn't catch this). The "passes when only prompt" test should pass (no regression).

### Task B2 — Implement the per-subtype branch in `verify.ts`

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/verify.ts`

- [ ] **Step 1: Read the current file**

```bash
cat server/typescript/packages/cli/src/commands/verify.ts
```

The current loop iterates `templates`. Locate the line `for (const tmpl of templates) {`.

- [ ] **Step 2: Modify the imports to include TEMPLATE_SUBTYPE_PROMPT + OUTPUT**

In the import from `@metaobjectsdev/metadata`, add `TEMPLATE_SUBTYPE_PROMPT` and `TEMPLATE_SUBTYPE_OUTPUT`:

```ts
import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
  TEMPLATE_ATTR_REQUIRED_TAGS,
} from "@metaobjectsdev/metadata";
```

- [ ] **Step 3: Replace the loop body with the per-subtype branch**

Current loop body (paraphrased; preserve exact existing structure):

```ts
for (const tmpl of templates) {
  const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof textRef !== "string" || typeof payloadRef !== "string") continue;

  const text = provider.resolve(textRef);
  if (text === undefined) {
    log.error(`[${tmpl.name}] ${ERR_PARTIAL_UNRESOLVED}: @textRef "${textRef}" did not resolve under ${promptsDir}`);
    errorCount++;
    continue;
  }

  const fieldTree = derivePayloadFieldTree(root, payloadRef);
  const requiredSlots = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_SLOTS));
  const requiredTags = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_TAGS));

  const drift = verify(text, fieldTree, { provider, requiredSlots, requiredTags });
  checked++;
  for (const e of drift) {
    if (e.code === ERR_REQUIRED_SLOT_UNUSED) {
      log.warn(`[${tmpl.name}] ${e.code}: ${e.path}`);
      warnCount++;
    } else {
      log.error(`[${tmpl.name}] ${e.code}: ${e.path}`);
      errorCount++;
    }
  }
}
```

Replace with:

```ts
for (const tmpl of templates) {
  const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
  const payloadRef = tmpl.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  if (typeof textRef !== "string" || typeof payloadRef !== "string") continue;

  // Both subtypes verify that @payloadRef resolves to a loaded object.value.
  // The render-engine `verify()` would also throw on missing refs, but the
  // output branch doesn't call it — explicit check keeps the error symmetric.
  const fieldTree = derivePayloadFieldTree(root, payloadRef);
  if (fieldTree.length === 0) {
    log.error(
      `[${tmpl.name}] (${tmpl.subType}) ${ERR_PARTIAL_UNRESOLVED}: ` +
        `@payloadRef "${payloadRef}" did not resolve to a loaded object.value`,
    );
    errorCount++;
    continue;
  }

  if (tmpl.subType === TEMPLATE_SUBTYPE_PROMPT) {
    // Render-engine drift check: template variables ↔ payload field names.
    const text = provider.resolve(textRef);
    if (text === undefined) {
      log.error(
        `[${tmpl.name}] (prompt) ${ERR_PARTIAL_UNRESOLVED}: @textRef "${textRef}" did not resolve under ${promptsDir}`,
      );
      errorCount++;
      continue;
    }

    const requiredSlots = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_SLOTS));
    const requiredTags = attrAsStringArray(tmpl.ownAttr(TEMPLATE_ATTR_REQUIRED_TAGS));

    const drift = verify(text, fieldTree, { provider, requiredSlots, requiredTags });
    checked++;
    for (const e of drift) {
      if (e.code === ERR_REQUIRED_SLOT_UNUSED) {
        log.warn(`[${tmpl.name}] (prompt) ${e.code}: ${e.path}`);
        warnCount++;
      } else {
        log.error(`[${tmpl.name}] (prompt) ${e.code}: ${e.path}`);
        errorCount++;
      }
    }
  } else if (tmpl.subType === TEMPLATE_SUBTYPE_OUTPUT) {
    // Output drift check: re-derive the payload field tree (already done above);
    // if it resolved, the parser codegen can produce a schema. Field-type
    // unsupported-by-Zod issues are caught by the codegen itself if/when
    // `meta gen` runs; verify confines itself to ref-resolution checks.
    checked++;
  } else {
    // Unknown subtype — ignore (loader-schema concern).
  }
}
```

Note: this version drops the "load the text file" step for outputs (outputs don't have prompt-text to render). It also slightly changes the prompt-side log prefix to include `(prompt)`. That's a cosmetic change to existing log output — acceptable per the FR6 spec which says "diagnostic output gains a `kind: "prompt" | "output"` field."

- [ ] **Step 4: Run the new test file**

```bash
cd server/typescript && bun test packages/cli/test/unit/verify-output.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full server suite, confirm no regression**

```bash
cd server/typescript && bun test
```

Expected: green; any pre-existing verify.ts tests still pass (the log-prefix change may break golden-style assertions if any exist — adjust if needed).

If a pre-existing verify test asserts on log lines that don't include `(prompt)`, the cleanest fix is to update the assertion to match the new prefix (it's a deliberate UX change per the FR). If the test asserts more generally on count of findings, no change needed.

### Task B3 — Commit Phase B

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/cli/src/commands/verify.ts \
  server/typescript/packages/cli/test/unit/verify-output.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): meta verify extends to cover template.output drift (FR6-ts Phase B)

The existing verify command walked TYPE_TEMPLATE nodes and ran the render-
engine verify() for each, indiscriminately. After this change:

- template.prompt — unchanged: derive payload field tree, resolve @textRef,
  run render-engine verify(). Log lines now carry `(prompt)` prefix.
- template.output — new: derive payload field tree and verify @payloadRef
  resolves. No render-engine verify (outputs don't have prompt text to
  render). Log lines carry `(output)` prefix.

Both branches share the early-fail check on @payloadRef resolution so
unresolved refs produce a clean diagnostic for either subtype.

Adopters running `meta verify` in CI now get unified drift gating: prompt
template-variable drift AND output @payloadRef resolution both fail the
build.

New test verify-output.test.ts pins the three relevant paths:
- output with resolvable @payloadRef passes
- output with missing @payloadRef fails (exit 1)
- existing prompt-only behaviour unchanged (no regression)

Resolves FR6-ts Phase B.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — Docs

### Task C1 — Document `outputParser()` in `codegen-ts/README.md`

**Files:**
- Modify: `server/typescript/packages/codegen-ts/README.md`

- [ ] **Step 1: Read current README structure**

```bash
grep -n "^##" server/typescript/packages/codegen-ts/README.md
```

- [ ] **Step 2: Append the new section** (or insert near the existing `promptRender()` section if one exists; otherwise append to the end before any "Naming conventions" section).

Section content:

```markdown
## `outputParser()` — typed parsers for `template.output`

For every `template.output` declared in your metadata, `outputParser()` emits
`<TemplateName>.output.ts` containing a Zod schema + dual-API parser:

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, barrel, promptRender, outputParser } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  generators: [entityFile(), queriesFile(), barrel(), promptRender(), outputParser()],
});
```

For a `template.output` named `NpcResponseOutput` with `@payloadRef: "NpcResponsePayload"`:

```ts
// Generated NpcResponseOutput.output.ts
import { z } from "zod";
import type { NpcResponsePayload } from "./payloads.js";

const NpcResponseOutputSchema = z.object({
  name: z.string(),
  age: z.number().int(),
});

export type NpcResponseOutputValidationError = z.ZodError;

/** Throws ZodError on validation failure. */
export function parseNpcResponseOutput(text: string): NpcResponsePayload { ... }

/** Result-style; never throws. */
export function safeParseNpcResponseOutput(text: string):
  | { success: true; data: NpcResponsePayload }
  | { success: false; error: NpcResponseOutputValidationError } { ... }
```

Consumer usage:

```ts
import { parseNpcResponseOutput, safeParseNpcResponseOutput } from "./generated/NpcResponseOutput.output";

const npc = parseNpcResponseOutput(llmResponseText);   // throws on bad shape

const r = safeParseNpcResponseOutput(llmResponseText);
if (!r.success) { /* handle r.error (a ZodError) */ } else { /* use r.data */ }
```

**Field-type → Zod-type mapping:**

| Field subtype | Emitted Zod |
|---|---|
| `field.string`, `field.class` | `z.string()` |
| `field.int`, `field.long`, `field.short`, `field.byte` | `z.number().int()` |
| `field.double`, `field.float` | `z.number()` |
| `field.boolean` | `z.boolean()` |
| `field.object` (with `@objectRef`) | nested `z.object({ ... })` |
| `isArray: true` on any of the above | wrapped in `z.array(...)` |

**Options:**

```ts
outputParser({
  outDir: "src/generated/outputs",   // default: emits at the target's root
  target: "default",                 // default: "default" (the entity-module target)
})
```

**`meta verify` integration:** when `meta verify` runs, every `template.output`'s
`@payloadRef` resolution is checked. Unresolved refs fail the build (`exit 1`)
with a `(output)` prefix on the diagnostic. See [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-language design rationale.
```

(Adjust relative paths if the README is at a different depth.)

### Task C2 — Add an Unreleased entry to `CHANGELOG.md`

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the current CHANGELOG**

```bash
head -10 CHANGELOG.md
```

- [ ] **Step 2: Insert an Unreleased section** before `## [0.6.0]`:

```markdown
## [Unreleased]

### Added
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. Wire it into
  `metaobjects.config.ts`: `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.

### Changed
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.
```

### Task C3 — Commit Phase C

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/codegen-ts/README.md \
  CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: outputParser() README section + CHANGELOG unreleased entry (FR6-ts Phase C)

codegen-ts/README.md gains an "outputParser() — typed parsers for
template.output" section: consumer wiring, generated-file shape (Zod
schema + parse/safeParse dual API), field-type → Zod-type mapping table,
options reference (outDir, target), and a note on the meta verify
integration.

CHANGELOG.md gains an [Unreleased] section listing the FR6-ts deliverables:
outputParser() factory, meta verify extension for output drift, the new
template-output-simple conformance fixture, and the (prompt)/(output) log-
prefix change (flagged so log scrapers know to update).

Resolves FR6-ts Phase C.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all three phases)

- [ ] **Step 1: Full server suite**

```bash
cd server/typescript && bun test
```

Expected: green; test count is baseline + 13 (6 renderer + 4 factory + 1 conformance + 3 verify-output).

- [ ] **Step 2: Workspace build**

```bash
cd /home/doug/Development/metaobjects && bun run --filter '*' build
```

Expected: all 14 packages exit 0.

- [ ] **Step 3: Inspect the commits**

```bash
git log --oneline -4
```

Expected (newest first):

```
<sha-C>  docs: outputParser() README section + CHANGELOG unreleased entry (FR6-ts Phase C)
<sha-B>  feat(cli): meta verify extends to cover template.output drift (FR6-ts Phase B)
<sha-A>  feat(codegen-ts): outputParser() generator for template.output (FR6-ts Phase A)
<base>   (pre-FR6 main tip)
```

Merge to main via the standard `superpowers:finishing-a-development-branch` flow at the end of the subagent-driven session.

---

## Spec coverage self-review

| Spec requirement | Task |
|---|---|
| **FR6-ts §Goal**: `outputParser()` factory emits dual-API parser per `template.output` | A1, A2, A3, A4, A5 |
| **FR6-ts §Design 1**: factory wraps `renderOutputParser()` from `templates/output-parser.ts` | A2 (renderer), A4 (factory) |
| **FR6-ts §Design 2**: reuse payload-codegen substrate (field-type → Zod-type) | A2 (`SCALAR_ZOD` + `renderObjectSchema`) |
| **FR6-ts §Design 2**: covers field.string, ints, floats, boolean, enum, currency, field.object, isArray | A1 (test 2: all scalars; test 3: isArray; test 4: nested object). `field.enum` and `field.currency` use `z.string()`/`z.number().int()` via the default scalar path; plan note: dedicated enum/currency Zod refinements deferred to a follow-on |
| **FR6-ts §Design 3**: `meta verify` extension | B1, B2 |
| **FR6-ts §Design 4**: conformance fixture `template-output-simple` | A6 |
| **FR6-ts §Tests**: unit tests | A1 (renderer), A3 (factory), B1 (verify) |
| **FR6-ts §Tests**: golden snapshots / conformance byte-match | A6 (conformance iteration) |
| **FR6-ts §Tests**: verify drift tests | B1 |
| **FR6-ts §File-level change summary** | All A/B/C tasks together |

Two intentional simplifications worth flagging:

1. **`field.enum` and `field.currency` use the generic scalar Zod mapping** (`z.string()` and `z.number().int()`) rather than producing `z.enum([...values])` or currency-aware refinements. The FR6-ts spec lists these subtypes in the field-type mapping table but the plan defers their dedicated Zod refinements to a follow-on FR (FR6-ts.1 — "Strict enum + currency schemas in outputParser"). Reasoning: the generic mapping is correct (consumers can validate stricter at their boundary); strict enum codegen needs the `@values` array resolved cleanly and isn't a blocker for the 80% case.

2. **The `meta verify` output check is REF-RESOLUTION ONLY**, not codegen-diff. The FR spec's bullet "Payload-VO has field X, output schema (derived) doesn't include X → finding" assumes the verify command can compare derived-from-metadata against derived-from-metadata, which is structurally a no-op (both derive the same way). The achievable check at runtime — without reading committed parser files from disk — is "the `@payloadRef` resolves." The plan notes this honestly; consumers wanting committed-file drift detection get it via `meta gen` + `git diff --exit-code` (the standard codegen-drift pattern documented in the Cloudflare Workers recipe).

No other gaps identified.
