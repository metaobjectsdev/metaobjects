// A3 — a declared template.prompt with no prompt generator wired emitted nothing and said
// nothing, while `meta verify` reported the template "clean".
//
// The payload value objects DO get emitted (they are `object.value` nodes, which the entity
// generator picks up), so the run looks like it worked: files appear, the exit code is 0, and
// the drift gate is green. What is missing is the entire pillar — no `render<Name>()` to send
// the prompt, no parser to read the reply, no response-format fragment.
//
// Found by declaring a prompt in a from-scratch app exactly as the shipped
// `metaobjects-prompts` skill teaches. The wiring is documented only in that skill's
// per-language reference fragment, pointed at in SKILL.md's last line.
//
// Follows the `layout.dataGrid` precedent (#287): tell the adopter at `meta gen` time,
// warning only, and self-extinguishing so a deliberate choice is never nagged.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { Generator } from "../src/generator.js";
import { warnMissingPromptGenerators } from "../src/prompt-generator-gate.js";

const MODEL = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.string": { name: "q", "@required": true } }],
        },
      },
      {
        "object.value": {
          name: "Verdict",
          children: [{ "field.string": { name: "a", "@required": true } }],
        },
      },
      {
        "template.prompt": {
          name: "triage",
          "@payloadRef": "Payload",
          "@textRef": "t/x",
          "@responseRef": "Verdict",
        },
      },
      {
        "template.prompt": {
          name: "summarise",
          "@payloadRef": "Payload",
          "@textRef": "t/y",
        },
      },
    ],
  },
};

async function loadRoot(doc: unknown = MODEL) {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const gen = (name: string, opts?: Partial<Generator>): Generator => ({ name, generate: () => [], ...opts });

function collect(
  root: Awaited<ReturnType<typeof loadRoot>>,
  generators: Generator[],
  // Defaults to "nothing in this suite writes to the docs target" — the behaviour of
  // every pre-R1 test, none of which modeled a docs-only run.
  isDocsTarget: (g: Generator) => boolean = () => false,
): string[] {
  const out: string[] = [];
  warnMissingPromptGenerators(root, generators, isDocsTarget, (m) => out.push(m));
  return out;
}

describe("A3 — declared prompts with no prompt generator wired", () => {
  test("warns, naming every template", async () => {
    const warnings = collect(await loadRoot(), [gen("entity-file"), gen("queries-file")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("triage");
    expect(warnings[0]).toContain("summarise");
    expect(warnings[0]).toContain("promptRender()");
  });

  test("names the receive half separately when a @responseRef asks for it", async () => {
    // ADR-0052: @responseRef is what asks for the inbound tier, so a responding prompt is
    // missing strictly more than an outbound-only one. One of the two here responds.
    const warnings = collect(await loadRoot(), [gen("entity-file")]);
    expect(warnings[0]).toContain("outputParser()");
    expect(warnings[0]).toContain("1 of them");
  });

  test("SELF-EXTINGUISHING: silent as soon as any prompt generator is wired", async () => {
    const root = await loadRoot();
    for (const name of ["prompt-render", "output-parser", "render-helper", "output-prompt"]) {
      expect(collect(root, [gen("entity-file"), gen(name)])).toEqual([]);
    }
  });

  test("silent on a model that declares no prompts at all", async () => {
    const root = await loadRoot({
      "metadata.root": {
        package: "acme::ai",
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                { "source.rdb": { "@table": "widgets" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    expect(collect(root, [gen("entity-file")])).toEqual([]);
  });

  // A docs-only project (its `generators` lists only docs generators, e.g.
  // `docsFile()`) was told to "Add promptRender()" and that its payload value objects
  // "were emitted regardless", though the run emitted no code of any kind — only docs.
  test("silent when the run lists no generator at all", async () => {
    expect(collect(await loadRoot(), [])).toEqual([]);
  });

  test("silent when every listed generator resolves to the docs target", async () => {
    const warnings = collect(
      await loadRoot(),
      [gen("docs-file"), gen("agent-docs")],
      () => true, // every generator in this run is docs-target
    );
    expect(warnings).toEqual([]);
  });

  test("still warns when a docs generator is mixed with a code generator", async () => {
    const warnings = collect(
      await loadRoot(),
      [gen("docs-file"), gen("entity-file")],
      (g) => g.name === "docs-file",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("promptRender()");
  });

  // The "payload value objects were emitted regardless" claim is only true when a
  // generator that actually emits entity/value-object modules (`emitsEntityModule`)
  // ran in this suite.
  test("drops the value-objects claim when no generator emits entity modules", async () => {
    const warnings = collect(await loadRoot(), [gen("queries-file")]);
    expect(warnings[0]).not.toContain("were emitted regardless");
  });

  test("keeps the value-objects claim when the entity generator is wired", async () => {
    const warnings = collect(await loadRoot(), [gen("entity-file", { emitsEntityModule: true })]);
    expect(warnings[0]).toContain("were emitted regardless");
  });
});
