// FR-010 codegen proof — the TS analogue of C#'s Fr010CodegenTests.cs (compile-AND-run).
//
// Generates the parser+extract file and the prompt file for a hand-built model, writes
// the emitted .ts (plus the payload interface) to a temp dir under this test dir, then
// dynamically import()s the emitted module under bun and CALLS the generated functions:
//   • extractLenient<Name>WithLoader(root, text) on a dirty input (preamble + ```json fence +
//     off-vocab enum alias + missing optional) — asserts the @enumAlias fold, classification,
//     and lost-optional. This is the single, loader-delegating extract path.
//   • render<Name>Format() — asserts the comment-free guide fragment.
// Also typechecks the emitted source via `tsc --noEmit` when available.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../src/templates/output-parser.js";
import { renderOutputPrompt } from "../src/templates/output-prompt.js";
import { generatePayloadInterfaces } from "../src/payload-codegen.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// A value-object exercising: string field with @example/@instruction, enum with
// @values/@enumAlias/@enumDoc, an int, an optional string, and a string array.
const MODEL = [
  {
    "object.value": {
      name: "Ticket",
      children: [
        {
          "field.string": {
            name: "subject",
            "@required": true,
            "@example": "Cannot log in",
            "@instruction": "a short summary",
          },
        },
        {
          "field.enum": {
            name: "priority",
            "@required": true,
            "@values": ["LOW", "HIGH"],
            "@enumAlias": { medium: "HIGH", med: "HIGH" },
            "@enumDoc": { LOW: "non-urgent", HIGH: "needs attention now" },
          },
        },
        { "field.int": { name: "score", "@required": true } },
        { "field.string": { name: "assignee" } },
        { "field.string": { name: "tags", isArray: true, "@required": true } },
      ],
    },
  },
  {
    "template.prompt": {
      name: "TicketOut",
      "@payloadRef": "Ticket",
          "@responseRef": "Ticket",
      "@textRef": "out/ticket",
    },
  },
];

describe("FR-010 codegen — extract-schema + output-format-spec emitters (source shape)", () => {
  test("output-parser emits the strict Zod parser AND the tolerant extract API for json", async () => {
    const root = await loadRoot(MODEL);
    const src = renderOutputParser(root, "TicketOut");

    // strict parser untouched
    expect(src).toContain("import { z } from \"zod\";");
    expect(src).toContain("export function parseTicketOut(text: string)");
    expect(src).toContain("export function safeParseTicketOut(");

    // extract API — the single, loader-delegating path (Move 1: no baked self-contained overload)
    expect(src).toContain('from "@metaobjectsdev/render"');
    expect(src).toContain('import { extractObject } from "@metaobjectsdev/runtime-ts";');
    expect(src).toContain("export interface TicketOutExtracted {");
    expect(src).toContain("export function extractLenientTicketOutWithLoader(");
    // nullable mirror
    expect(src).toContain("priority: string | null;");
    expect(src).toContain("score: number | null;");
    expect(src).toContain("tags: (string | null)[] | null;");

    // No baked snapshot survives.
    expect(src).not.toContain("ExtractSchema =");
    expect(src).not.toContain("enumField(");
    expect(src).not.toContain("export function extractLenientTicketOut(");
    expect(src).not.toContain("tryExtractLenientTicketOut");
  });

  test("text-format output gets NO extract block", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Note", children: [{ "field.string": { name: "body", "@required": true } }] } },
      { "template.prompt": { name: "NoteOut", "@payloadRef": "Note",
          "@responseRef": "Note", "@textRef": "out/note", "@format": "text" } },
    ]);
    const src = renderOutputParser(root, "NoteOut");
    expect(src).toContain("export function parseNoteOut(");
    expect(src).not.toContain("extractLenientNoteOut");
    expect(src).not.toContain("@metaobjectsdev/render");
  });

  test("output-prompt emits a guide-style spec literal with @example/@instruction/@enumDoc", async () => {
    const root = await loadRoot(MODEL);
    const src = renderOutputPrompt(root, "TicketOut");
    expect(src).toContain("export function renderTicketOutFormat(");
    expect(src).toContain("renderOutputFormat(");
    expect(src).toContain("rootName: \"Ticket\"");
    expect(src).toContain("style: PromptStyle.GUIDE");
    expect(src).toContain('example: "Cannot log in"');
    expect(src).toContain('instruction: "a short summary"');
    expect(src).toContain('enumDoc: { "HIGH": "needs attention now", "LOW": "non-urgent" }');
  });
});

// FR-011: a value-object with @normalize at the object level, carrying an enum that
// declares @coerceDefault. The off-vocab dirty input must fold to the coerceDefault member
// and classify DEFAULTED; the emitted enumField(...) literal must carry the new positional
// args (coerceDefault + resolved normalize).
const MODEL_FR011 = [
  {
    "object.value": {
      name: "Task",
      "@normalize": "strip",
      children: [
        { "field.string": { name: "title", "@required": true } },
        {
          "field.enum": {
            name: "priority",
            "@required": true,
            "@values": ["LOW", "HIGH"],
            "@coerceDefault": "LOW",
          },
        },
      ],
    },
  },
  {
    "template.prompt": {
      name: "TaskOut",
      "@payloadRef": "Task",
          "@responseRef": "Task",
      "@textRef": "out/task",
    },
  },
];

describe("FR-011 codegen — @coerceDefault/@normalize via the loader-delegating extract (import-and-RUN proof)", () => {
  test("extractLenientTaskOutWithLoader() folds an off-vocab value to @coerceDefault and classifies DEFAULTED", async () => {
    const root = await loadRoot(MODEL_FR011);
    const parserSrc = renderOutputParser(root, "TaskOut");
    const payloadSrc = generatePayloadInterfaces(root, "Task");

    const dir = mkdtempSync(join(import.meta.dir, "fr011-emit-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), payloadSrc);
    writeFileSync(join(dir, "TaskOut.output.ts"), parserSrc);

    const parser = await import(join(dir, "TaskOut.output.ts"));

    // off-vocab, non-aliasable enum value → @coerceDefault fallback to "LOW". The delegating
    // extract reads the @coerceDefault/@normalize attrs directly off the live metadata.
    const dirty = '{ "title": "Ship it", "priority": "kinda high!!" }';
    const { data, report } = parser.extractLenientTaskOutWithLoader(root, dirty);
    expect(data).not.toBeNull();
    expect(data.priority).toBe("LOW");
    expect(data.title).toBe("Ship it");
    // coerceDefault fold → DEFAULTED state
    expect(report.states().get("priority")).toBe("DEFAULTED");
    expect(report.hasLostRequired()).toBe(false);
  });
});

describe("FR-010 codegen — import-and-RUN proof (bun dynamic import)", () => {
  test("emitted extractLenientTicketOut() folds the @enumAlias + classifies a dirty input; renderTicketOutFormat() emits the guide fragment", async () => {
    const root = await loadRoot(MODEL);
    const parserSrc = renderOutputParser(root, "TicketOut");
    const promptSrc = renderOutputPrompt(root, "TicketOut");
    const payloadSrc = generatePayloadInterfaces(root, "Ticket");

    const dir = mkdtempSync(join(import.meta.dir, "fr010-emit-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), payloadSrc);
    writeFileSync(join(dir, "TicketOut.output.ts"), parserSrc);
    writeFileSync(join(dir, "TicketOut.prompt.ts"), promptSrc);

    const parser = await import(join(dir, "TicketOut.output.ts"));
    const prompt = await import(join(dir, "TicketOut.prompt.ts"));

    // ---- extract() on a dirty input: preamble + ```json fence + off-vocab alias + missing optional ----
    const dirty = [
      "Sure! Here is the ticket you asked for:",
      "```json",
      '{ "subject": "Cannot log in", "priority": "medium", "score": 7, "tags": ["auth", "login"] }',
      "```",
      "Hope that helps!",
    ].join("\n");

    const { data, report } = parser.extractLenientTicketOutWithLoader(root, dirty);
    expect(data).not.toBeNull();
    // @enumAlias fold: off-vocab "medium" → canonical "HIGH"
    expect(data.priority).toBe("HIGH");
    expect(data.subject).toBe("Cannot log in");
    expect(data.score).toBe(7);
    expect(data.tags).toEqual(["auth", "login"]);
    // the optional "assignee" was absent → null + classified LOST_OPTIONAL
    expect(data.assignee).toBeNull();
    expect(report.isEmpty()).toBe(false);
    expect(report.hasLostRequired()).toBe(false);
    const states = report.states();
    expect(states.get("assignee")).toBe("LOST_OPTIONAL");
    expect(states.get("priority")).toBe("EXTRACTED");

    // The bool-gate is now derived from the report by the caller (the self-contained
    // tryExtract<Name> wrapper was removed with the baked path): non-empty + no required lost.
    const gateOk = (r: typeof report) => !r.isEmpty() && !r.hasLostRequired();
    expect(gateOk(report)).toBe(true);

    // ---- gate ok:FALSE branches (run-asserted) ----
    // (a) a payload that LOST a @required field (omit `subject`/`priority`/`score`/`tags`) →
    //     gate false because report.hasLostRequired() is true.
    const lostRequired = '{ "assignee": "Grace" }';
    const lost = parser.extractLenientTicketOutWithLoader(root, lostRequired);
    expect(gateOk(lost.report)).toBe(false);
    expect(lost.report.hasLostRequired()).toBe(true);
    expect(lost.report.lostRequired()).toContain("subject");

    // (b) empty/garbage input → gate false because report.isEmpty() is true.
    const empty = parser.extractLenientTicketOutWithLoader(root, "   ");
    expect(gateOk(empty.report)).toBe(false);
    expect(empty.report.isEmpty()).toBe(true);
    expect(empty.report).toBeDefined();

    // ---- render*Format(): comment-free guide fragment ----
    const fragment: string = prompt.renderTicketOutFormat();
    expect(fragment).toContain("Fill in each field as described below:");
    expect(fragment).toContain("- subject (required): a short summary");
    expect(fragment).toContain("- priority (required)");
    expect(fragment).toContain("one of LOW, HIGH");
    expect(fragment).toContain("HIGH = needs attention now");
    expect(fragment).toContain("Respond exactly like this:");
    // guide skeleton uses the declared example for subject + first enum value for priority
    expect(fragment).toContain('"subject": "Cannot log in"');
    expect(fragment).toContain('"priority": "LOW"');
    // no source-comment leakage into the fragment
    expect(fragment).not.toContain("//");
    expect(fragment).not.toContain("/*");
  });
});
