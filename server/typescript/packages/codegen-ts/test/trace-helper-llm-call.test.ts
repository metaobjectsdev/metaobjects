// The trace helper's call loop is written into the project (1.3.0 T10b, ADR-0024 Amendment 2).
//
// Until 1.3.0 the generated `call<Entity>` imported `runLlmCall` and the `LlmClient` seam from
// `@metaobjectsdev/ai-runtime`, a package the project had to install. The `trace-helper`
// generator now writes the same loop as `llm-call.ts` beside the helpers, so generated code
// depends only on the ordinary published packages it already imported.
//
// Proven three ways, all against the generated tree:
//   1. it compiles with the real TypeScript compiler, and the program never reaches the
//      ai-runtime package's files;
//   2. the generated `runLlmCall` behaves as ai-runtime's did — the expectations are the ones
//      `ai-runtime/test/call-loop.test.ts` held that package to;
//   3. the generated `call<Entity>` renders, calls, extracts and persists one typed row.

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "./compile-timeout.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { librarySources } from "@metaobjectsdev/metadata/library";
import { entityFile } from "../src/generators/entity-file.js";
import { traceHelperFile } from "../src/generators/trace-helper-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

const MODEL = {
  "metadata.root": {
    package: "app::ops",
    children: [
      { "object.value": { name: "AskVO", children: [{ "field.string": { name: "question", "@required": true } }] } },
      { "object.value": { name: "AnswerVO", children: [{ "field.string": { name: "answer", "@required": true } }] } },
      {
        "object.entity": {
          name: "ApiCall",
          extends: "metaobjects::ai::LlmCallBase",
          children: [
            { "source.rdb": { "@table": "api_call", "@role": "primary" } },
            { "identity.primary": { name: "id", "@fields": ["traceId"] } },
            {
              "template.prompt": {
                name: "AskPrompt",
                "@payloadRef": "AskVO",
                "@responseRef": "AnswerVO",
                "@textRef": "p/ask",
                "@format": "text",
              },
            },
          ],
        },
      },
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    ...librarySources(["ai"]),
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors.map((e) => e.message)).toEqual([]);
  return res.root;
}

async function generate(root: MetaRoot, dir: string): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    outputLayout: "flat",
    dialect: "postgres",
    loadedRoot: root,
    outDir: dir,
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx = (g: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => g.filter?.(e) ?? true,
    projectRoot: dir,
    config: { outputLayout: "flat", outDir: dir, extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  });
  const generators = [entityFile({ allowlists: false }), traceHelperFile()];
  return (await Promise.all(generators.map((g) => g.generate(ctx(g))))).flat();
}

/** Generate into a fresh directory beside this test (so the workspace packages resolve), run `body`, remove it. */
async function withTree<T>(body: (dir: string, root: MetaRoot, files: EmittedFile[]) => Promise<T>): Promise<T> {
  const root = await loadModel();
  const dir = mkdtempSync(join(import.meta.dir, "tmp-trace-llm-call-"));
  try {
    const files = await generate(root, dir);
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    return await body(dir, root, files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The generated `runLlmCall`, typed loosely: the compile test above is what checks its types. */
type RunLlmCall = (
  input: { callType: string; request: { prompt: string; model: string }; traceId?: string },
  deps: Record<string, unknown>,
) => Promise<{ input: Record<string, unknown>; completion?: { body: string } }>;

describe("trace-helper writes its call loop into the project", () => {
  test("the helper and llm-call.ts compile, and the program never reaches the ai-runtime package", async () => {
    await withTree(async (dir, _root, files) => {
      const paths = files.map((f) => f.path);
      expect(paths).toContain("ApiCall.trace.ts");
      expect(paths).toContain("llm-call.ts");
      // A caller typed against the generated surface only.
      writeFileSync(
        join(dir, "caller.ts"),
        [
          `import { callApiCall } from "./ApiCall.trace";`,
          `import type { LlmClient, CostFn } from "./llm-call";`,
          `declare const deps: Omit<Parameters<typeof callApiCall>[1], "client" | "cost">;`,
          `const client: LlmClient = { complete: async (req) => ({ body: req.prompt }) };`,
          `const cost: CostFn = () => 1;`,
          `export const run = () => callApiCall({ question: "why" }, { ...deps, client, cost });`,
        ].join("\n"),
      );
      const program = ts.createProgram(
        [...paths, "caller.ts"].map((p) => join(dir, p)),
        {
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
        },
      );
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
      const aiRuntime = `${sep}ai-runtime${sep}`;
      expect(program.getSourceFiles().map((f) => f.fileName).filter((f) => f.includes(aiRuntime))).toEqual([]);
    });
  });

  test("runLlmCall behaves as ai-runtime's did: ids, latency, cost, a supplied trace, a client that throws", async () => {
    await withTree(async (dir) => {
      const mod = (await import(join(dir, "llm-call.ts"))) as { runLlmCall: RunLlmCall };
      let t = 1000;
      const clock = { now: () => (t += 500) };
      let n = 0;
      const ids = { next: () => `id${++n}` };
      const client = {
        async complete(req: { model: string }) {
          return { body: `{"verdict":"ok"}`, model: req.model, usage: { inputTokens: 10, outputTokens: 20 } };
        },
      };

      const ok = await mod.runLlmCall({ callType: "Verdict", request: { prompt: "P", model: "gpt-4o-mini" } }, { client, clock, ids, cost: () => 75 });
      expect(ok.input.spanId).toBe("id1");
      expect(ok.input.traceId).toBe("id2");
      expect(ok.input.latencyMs).toBe(500);
      expect(ok.input.startedAt).toBe(new Date(1500).toISOString());
      expect(ok.input.status).toBe("ok");
      expect(ok.input.requestModel).toBe("gpt-4o-mini");
      expect(ok.input.inputTokens).toBe(10);
      expect(ok.input.outputTokens).toBe(20);
      expect(ok.input.costMinor).toBe(75);
      expect(ok.input.llmResponseText).toBe(`{"verdict":"ok"}`);
      expect(ok.completion?.body).toBe(`{"verdict":"ok"}`);

      const noCost = await mod.runLlmCall({ callType: "X", request: { prompt: "p", model: "m" } }, { client });
      expect("costMinor" in noCost.input).toBe(false);

      n = 0;
      const kept = await mod.runLlmCall({ callType: "V", request: { prompt: "P", model: "m" }, traceId: "T-EXIST" }, { client, ids });
      expect(kept.input.traceId).toBe("T-EXIST");
      expect(kept.input.spanId).toBe("id1");

      const thrown = await mod.runLlmCall(
        { callType: "V", request: { prompt: "P", model: "m" } },
        { client: { complete: async () => { throw new Error("boom"); } } },
      );
      expect(thrown.input.status).toBe("error");
      expect(thrown.input.errorDetail).toContain("boom");
      expect(thrown.completion).toBeUndefined();
    });
  });

  test("call<Entity> renders the prompt, calls the client, and persists one typed row", async () => {
    await withTree(async (dir, root) => {
      const trace = (await import(join(dir, "ApiCall.trace.ts"))) as {
        callApiCall: (payload: { question: string }, deps: Record<string, unknown>) => Promise<{ status: string; errorDetail: string | null; voResponse: unknown }>;
      };
      const created: Array<{ entity: string; row: Record<string, unknown> }> = [];
      const om = { create: async (entity: string, row: Record<string, unknown>) => { created.push({ entity, row }); return row; } };
      const prompts: string[] = [];
      const responseMo = root.findObject("app::ops::AnswerVO");
      expect(responseMo).toBeDefined();
      let n = 0;
      const result = await trace.callApiCall(
        { question: "why" },
        {
          om,
          responseMo,
          client: { complete: async (req: { prompt: string }) => { prompts.push(req.prompt); return { body: `{"answer":"42"}` }; } },
          provider: { resolve: (ref: string) => (ref === "p/ask" ? "Q: {{question}}" : undefined) },
          model: "m",
          ids: { next: () => `id${++n}` },
          cost: () => 3,
        },
      );
      expect(prompts).toEqual(["Q: why"]);
      expect(result).toEqual({ status: "ok", errorDetail: null, voResponse: { answer: "42" } });
      expect(created.length).toBe(1);
      expect(created[0]!.entity).toBe("ApiCall");
      const row = created[0]!.row;
      expect(row.callType).toBe("ApiCall");
      expect(row.spanId).toBe("id1");
      expect(row.traceId).toBe("id2");
      expect(row.costMinor).toBe(3);
      expect(row.voRequest).toEqual({ question: "why" });
      expect(row.voResponse).toEqual({ answer: "42" });
    });
  });
});
