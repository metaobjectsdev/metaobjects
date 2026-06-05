/**
 * End-to-end proof that `meta gen` triggers deriveTraceFields:
 * a trace entity (extends LlmCallBase, nests template.prompt) emits
 * voRequest / voResponse jsonb columns in the generated TS file.
 *
 * The real gen-command path is exercised: run() → genCommand() →
 * loadMemory(..., { preFreeze: deriveTraceFields }) → runGen().
 */
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

// Temp dirs live inside the fixtures tree so workspace packages
// (@metaobjectsdev/*) are resolvable by jiti when it loads metaobjects.config.ts.
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

const TRACE_METADATA = JSON.stringify({
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.value": { name: "AiReqVO", children: [{ "field.string": { name: "prompt" } }] } },
      { "object.value": { name: "AiResVO", children: [{ "field.string": { name: "output" } }] } },
      {
        "object.entity": {
          name: "LlmCallBase",
          abstract: true,
          children: [
            { "field.uuid": { name: "spanId" } },
            { "field.string": { name: "model" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ClassifyCall",
          extends: "LlmCallBase",
          children: [
            { "source.rdb": { "@table": "classify_call", "@role": "primary" } },
            { "identity.primary": { "@fields": ["spanId"] } },
            {
              "template.prompt": {
                name: "ClassifyPrompt",
                "@payloadRef": "AiReqVO",
                "@responseRef": "AiResVO",
                "@textRef": "prompts/classify",
                "@format": "xml",
              },
            },
          ],
        },
      },
    ],
  },
});

function setupTraceProject(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-trace-fields-"));
  const metaDir = join(root, "metaobjects");
  const outDir = join(root, "generated");
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, "meta.ai.json"), TRACE_METADATA);
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile(), barrel()],
});
`,
  );
  return root;
}

describe("meta gen — deriveTraceFields wired into gen command", () => {
  test("ClassifyCall entity gets voRequest + voResponse jsonb columns via preFreeze", async () => {
    const root = setupTraceProject();
    const outDir = join(root, "generated");
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      expect(existsSync(outDir)).toBe(true);

      const generated = readFileSync(join(outDir, "ClassifyCall.ts"), "utf8");

      // Derived columns must appear in the Drizzle schema
      expect(generated).toContain("voRequest");
      expect(generated).toContain("voResponse");
      expect(generated).toContain("jsonb");
      // The source table name must be present
      expect(generated).toContain("classify_call");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("entity without a template.prompt is untouched (no spurious columns)", async () => {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "gen-trace-plain-"));
    const metaDir = join(root, "metaobjects");
    const outDir = join(root, "generated");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      join(metaDir, "meta.widget.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::core",
          children: [
            {
              "object.entity": {
                name: "Widget",
                children: [
                  { "source.rdb": { "@table": "widget", "@role": "primary" } },
                  { "field.uuid": { name: "id" } },
                  { "identity.primary": { "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
    );
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);

      const generated = readFileSync(join(outDir, "Widget.ts"), "utf8");
      expect(generated).not.toContain("voRequest");
      expect(generated).not.toContain("voResponse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
