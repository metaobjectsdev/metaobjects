// FR-043 §6 — `trace-helper` keys on a library ANCHOR, not on a hard-coded name.
//
// What this replaces: `const LLM_CALL_BASE = "LlmCallBase"`, compared against `.name`
// anywhere in an entity's super chain. Any adopter entity called `LlmCallBase`, in any
// package, triggered the generator — and the shipped abstract it was meant to key on
// was never actually the thing being matched, which is how the whole codegen suite came
// to test this generator against bespoke bases wearing that name (ADR-0024's complaint,
// on this port).
//
// The anchor is declared in `library/ai/library.json` and RESOLVED: to a node in the
// run's own loaded root, compared by node identity.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { librarySources, libraryManifests } from "@metaobjectsdev/metadata/library";
import { traceHelperFile } from "../../src/generators/trace-helper-file.js";
import type { GenContext } from "../../src/generator.js";

/** An entity extending `base`, with the prompt + VO columns the helper needs. */
function model(base: string, extras: unknown[] = []): string {
  return JSON.stringify({
    "metadata.root": {
      package: "app::ops",
      children: [
        ...extras,
        { "object.value": { name: "AskVO", children: [{ "field.string": { name: "question" } }] } },
        { "object.value": { name: "AnswerVO", children: [{ "field.string": { name: "answer" } }] } },
        {
          "object.entity": {
            name: "ApiCall",
            extends: base,
            children: [
              { "source.rdb": { "@table": "api_call", "@role": "primary" } },
              { "identity.primary": { name: "id", "@fields": ["traceId"] } },
              {
                "template.prompt": {
                  name: "AskPrompt",
                  "@textRef": "p/ask",
                  "@payloadRef": "AskVO",
                  "@responseRef": "AnswerVO",
                  "@format": "json",
                },
              },
            ],
          },
        },
      ],
    },
  });
}

/** The adopter's OWN abstract, named exactly like the shipped one. */
const IMPOSTOR = {
  "object.entity": {
    name: "LlmCallBase",
    abstract: true,
    children: [
      { "field.uuid": { name: "traceId" } },
      { "field.string": { name: "callType" } },
      { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
    ],
  },
};

async function emitCount(
  doc: string,
  opts: { withLibrary: boolean; libraries?: GenContext["libraries"] },
): Promise<number> {
  const res = await new MetaDataLoader().load([
    ...(opts.withLibrary ? librarySources(["ai"]) : []),
    new InMemoryStringSource(doc, { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  const ctx = {
    entities: res.root.objects(),
    loadedRoot: res.root,
    matches: () => true,
    config: { outDir: "/tmp/out", dialect: "postgres" } as never,
    ...(opts.libraries !== undefined ? { libraries: opts.libraries } : {}),
    warn: () => {},
  } as GenContext;
  return (await traceHelperFile().generate(ctx)).length;
}

const AI = [libraryManifests()["ai"]!];

describe("trace-helper keys on the library anchor (FR-043 §6)", () => {
  test("fires for an entity extending the SHIPPED base", async () => {
    const count = await emitCount(model("metaobjects::ai::LlmCallBase"), {
      withLibrary: true,
      libraries: AI,
    });
    expect(count).toBe(1);
  });

  test("does NOT fire for an adopter's own abstract of the same NAME", async () => {
    // The latent bug, pinned. `app::ops::LlmCallBase` is a different node in a
    // different package, and the helper it would have emitted writes columns that
    // entity does not declare.
    const count = await emitCount(model("LlmCallBase", [IMPOSTOR]), {
      withLibrary: true,
      libraries: AI,
    });
    expect(count).toBe(0);
  });

  test("an EMPTY selection is honoured: the caller looked, and nothing is opted in", async () => {
    const count = await emitCount(model("metaobjects::ai::LlmCallBase"), {
      withLibrary: true,
      libraries: [],
    });
    expect(count).toBe(0);
  });

  test("no selection at all falls back to every shipped anchor — still FQN, never a bare name", async () => {
    // A programmatic `runGen()` that never threads `libraries`. The fallback keeps
    // that caller working without reintroducing the name match: the impostor arm
    // below is the half that proves it.
    expect(await emitCount(model("metaobjects::ai::LlmCallBase"), { withLibrary: true })).toBe(1);
    expect(await emitCount(model("LlmCallBase", [IMPOSTOR]), { withLibrary: true })).toBe(0);
  });
});
