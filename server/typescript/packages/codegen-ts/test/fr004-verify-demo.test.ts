// FR-004 Plan #3, T7 — THE DEMO (definition of done for the fourth pillar).
//
// Proves BOTH halves of the typed-prompt guarantee on the AuthorBrief projection:
//
//   (a) compile-time — the Phase B generators emit a payload `interface` + a
//       typed render handle; a wrong-shaped payload at the call site is a TYPE
//       ERROR. We compile the generated code + a consumer with the TS compiler
//       API and assert the `// @ts-expect-error` line is genuinely needed (zero
//       diagnostics WITH it; an error on that exact line WITHOUT it).
//
//   (b) build-time — `verify` parses the opaque template text and flags a
//       variable the payload doesn't declare (ERR_VAR_NOT_ON_PAYLOAD).
//
// (a) uses the TS compiler API (not `bun test`'s type system, and not a spawned
// `bun run typecheck`) so it is hermetic + immune to workspace self-link noise.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { verify, ERR_VAR_NOT_ON_PAYLOAD, type PayloadField } from "@metaobjectsdev/render";
import { generatePayloadInterfaces, generateRenderHandle } from "../src/payload-codegen.js";

// The AuthorBrief projection over the trainerWebsite test entities (Plan #3 T3/T4).
const model = [
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title", "@required": true } }] } },
  {
    // Sourceless object.projection host (#210 — a value may host only
    // origin.passthrough). `posts` carried an `origin.collection @via "Author.posts"`
    // until FR-037 R2 retired the subtype (#336); no surviving origin expresses a
    // whole-object rollup (@agg:collect reduces a COLUMN via @of) until #335 lands.
    // Both halves this demo proves — the emitted interface and the verify drift
    // check — read the DECLARED shape (#270), so neither moves.
    "object.projection": {
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

async function loadRoot() {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children: model } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// Ambient stub so the generated `import … from "@metaobjectsdev/render"` resolves
// in an isolated program (the engine's real surface; just enough of it).
const RENDER_STUB = `declare module "@metaobjectsdev/render" {
  export interface Provider { resolve(ref: string): string | undefined; }
  export function render(o: {
    ref?: string; template?: string; payload: unknown; provider: Provider; format?: string;
  }): string;
}
`;

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program);
}

describe("FR-004 T7 — THE DEMO (both failures)", () => {
  test("(a) compile-time: a wrong-shaped payload is rejected by the generated handle", async () => {
    const root = await loadRoot();
    const payloads = generatePayloadInterfaces(root, "AuthorBrief", "acme::ai");
    const handle = generateRenderHandle(root, "contentStrategyPrompt");

    // Sanity: the generators produced the demo inputs the plan describes.
    expect(payloads).toContain("export interface AuthorBrief {");
    expect(payloads).toContain("posts: PostBrief[];");
    expect(handle).toContain(
      "export function renderContentStrategyPrompt(payload: AuthorBrief, provider: Provider): string",
    );

    const dir = mkdtempSync(join(tmpdir(), "fr004-t7-"));
    try {
      writeFileSync(join(dir, "payloads.ts"), payloads);
      writeFileSync(join(dir, "handles.ts"), handle);
      writeFileSync(join(dir, "render.d.ts"), RENDER_STUB);

      const header = [
        `import { renderContentStrategyPrompt } from "./handles.js";`,
        `import type { AuthorBrief } from "./payloads.js";`,
        `import type { Provider } from "@metaobjectsdev/render";`,
        `const provider: Provider = { resolve: () => undefined };`,
        `const good: AuthorBrief = { displayName: "Ada", postCount: 1, posts: [] };`,
        `void renderContentStrategyPrompt(good, provider);            // ✓ type-checks`,
      ].join("\n");

      // WITH the directive: must compile cleanly. Zero diagnostics proves both
      // that the valid call type-checks AND that the wrong-shape call genuinely
      // errors (otherwise tsc emits TS2578 "unused @ts-expect-error").
      writeFileSync(
        join(dir, "consumer.ts"),
        `${header}\n// @ts-expect-error — wrong payload shape is a compile error\nvoid renderContentStrategyPrompt({ nope: 1 }, provider);\n`,
      );
      const withDirective = compile(dir, ["consumer.ts", "handles.ts", "payloads.ts", "render.d.ts"]);
      expect(withDirective.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);

      // WITHOUT the directive: the wrong-shape call must surface a type error —
      // the compile-time enforcement, shown directly.
      writeFileSync(
        join(dir, "consumer-bad.ts"),
        `${header}\nvoid renderContentStrategyPrompt({ nope: 1 }, provider);\n`,
      );
      const withoutDirective = compile(dir, [
        "consumer-bad.ts",
        "handles.ts",
        "payloads.ts",
        "render.d.ts",
      ]);
      expect(withoutDirective.length).toBeGreaterThan(0);
      // The error is a payload-shape mismatch (excess prop / not assignable), not
      // a resolution failure — guard against a false positive from a broken setup.
      expect(withoutDirective.some((d) => d.code === 2353 || d.code === 2345)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b) build-time: verify flags a template variable absent from the payload", () => {
    const authorBriefFields: PayloadField[] = [
      { name: "displayName" },
      { name: "postCount" },
      { name: "posts", fields: [{ name: "title" }, { name: "tags", fields: [{ name: "name" }] }] },
    ];
    const drift = verify("Hi {{displayName}}, you have {{notARealField}}.", authorBriefFields);
    expect(drift.map((e) => e.code)).toContain(ERR_VAR_NOT_ON_PAYLOAD);
    expect(drift.find((e) => e.code === ERR_VAR_NOT_ON_PAYLOAD)?.path).toBe("notARealField");
  });
});
