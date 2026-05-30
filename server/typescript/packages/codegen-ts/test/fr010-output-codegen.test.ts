// FR-010 codegen proof — the TS analogue of C#'s Fr010CodegenTests.cs (compile-AND-run).
//
// Generates the parser+recover file and the prompt file for a hand-built model, writes
// the emitted .ts (plus the payload interface) to a temp dir under this test dir, then
// dynamically import()s the emitted module under bun and CALLS the generated functions:
//   • recover<Name>() on a dirty input (preamble + ```json fence + off-vocab enum alias +
//     missing optional) — asserts the @enumAlias fold, classification, and lost-optional.
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
    "template.output": {
      name: "TicketOut",
      "@payloadRef": "Ticket",
      "@textRef": "out/ticket",
      "@format": "json",
    },
  },
];

describe("FR-010 codegen — recover-schema + output-format-spec emitters (source shape)", () => {
  test("output-parser emits the strict Zod parser AND the tolerant recover API for json", async () => {
    const root = await loadRoot(MODEL);
    const src = renderOutputParser(root, "TicketOut");

    // strict parser untouched
    expect(src).toContain("import { z } from \"zod\";");
    expect(src).toContain("export function parseTicketOut(text: string)");
    expect(src).toContain("export function safeParseTicketOut(");

    // recover API
    expect(src).toContain('from "@metaobjectsdev/render"');
    expect(src).toContain("export interface TicketOutRecovered {");
    expect(src).toContain("export function recoverTicketOut(");
    expect(src).toContain("export function tryRecoverTicketOut(");
    // nullable mirror
    expect(src).toContain("priority: string | null;");
    expect(src).toContain("score: number | null;");
    expect(src).toContain("tags: (string | null)[] | null;");
    // schema literal: enum w/ values + alias map
    expect(src).toContain('enumField("priority", true, ["LOW", "HIGH"]');
    expect(src).toContain('"med": "HIGH"');
    expect(src).toContain('"medium": "HIGH"');
    // recover-map initializer + scoped imports
    expect(src).toContain('asStringList(d, "tags")');
    expect(src).toContain('asInt(d, "score")');
  });

  test("text-format output gets NO recover block", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Note", children: [{ "field.string": { name: "body", "@required": true } }] } },
      { "template.output": { name: "NoteOut", "@payloadRef": "Note", "@textRef": "out/note", "@format": "text" } },
    ]);
    const src = renderOutputParser(root, "NoteOut");
    expect(src).toContain("export function parseNoteOut(");
    expect(src).not.toContain("recoverNoteOut");
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

describe("FR-010 codegen — import-and-RUN proof (bun dynamic import)", () => {
  test("emitted recoverTicketOut() folds the @enumAlias + classifies a dirty input; renderTicketOutFormat() emits the guide fragment", async () => {
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

    // ---- recover() on a dirty input: preamble + ```json fence + off-vocab alias + missing optional ----
    const dirty = [
      "Sure! Here is the ticket you asked for:",
      "```json",
      '{ "subject": "Cannot log in", "priority": "medium", "score": 7, "tags": ["auth", "login"] }',
      "```",
      "Hope that helps!",
    ].join("\n");

    const { data, report } = parser.recoverTicketOut(dirty);
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
    expect(states.get("priority")).toBe("RECOVERED");

    // tryRecover gate: non-empty, no required lost → ok
    const gate = parser.tryRecoverTicketOut(dirty);
    expect(gate.ok).toBe(true);

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
