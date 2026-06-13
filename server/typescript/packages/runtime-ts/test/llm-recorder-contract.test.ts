// Contract gate: the keys buildLlmCallRow() writes MUST equal LlmCallBase's
// effective field set.
//
// This is the regression guard for the headline bug — recordLlmCall once wrote a
// `voResponse` key that the shipped abstract base (`library/ai/llm-call.yaml`,
// `metaobjects::ai::LlmCallBase`) does not declare, so the documented adoption
// path (`extends metaobjects::ai::LlmCallBase` → generated `record<Entity>`)
// threw `Unknown field 'voResponse'`. By loading the REAL shipped base via the
// loader's `libraries: ["ai"]` option and asserting set-equality against the
// recorder's row keys, recorder<->base divergence becomes a build failure: add
// or remove a key on either side and this test goes red.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildLlmCallRow, type LlmCallInput } from "../src/llm-recorder.js";

// A minimal concrete app entity that extends the library-shipped abstract base.
// Loading via fromDirectory + { libraries: ["ai"] } brings in the real
// metaobjects::ai::LlmCallBase, so the gate is coupled to the shipped YAML —
// not a hand-rolled copy of the field list.
const APP_YAML = [
  "metadata:",
  "  package: app::ops",
  "  children:",
  "    - object.entity:",
  "        name: ApiCall",
  "        extends: metaobjects::ai::LlmCallBase",
  "        children:",
  "          - source.rdb: { table: api_call, role: primary }",
  '          - identity.primary: { name: id, fields: ["spanId"] }',
].join("\n");

const MINIMAL_INPUT: LlmCallInput = {
  spanId: "11111111-1111-4111-8111-111111111111",
  traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  callType: "Verdict",
  startedAt: "2026-06-03T00:00:00.000Z",
  llmRequest: { question: "ship it?" },
  llmResponseText: '{"verdict":"approve"}',
  status: "ok",
  errorDetail: null,
};

describe("recorder <-> LlmCallBase contract gate", () => {
  test("buildLlmCallRow keys == LlmCallBase effective field set (shipped base)", async () => {
    // 1. Load the shipped LlmCallBase via the libraries option.
    const dir = mkdtempSync(join(tmpdir(), "llm-contract-"));
    writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
    let baseFieldNames: string[];
    try {
      const result = await MetaDataLoader.fromDirectory(dir, { libraries: ["ai"] });
      expect(result.errors, "shipped library + app entity must load cleanly").toEqual([]);

      // 2. LlmCallBase's effective field names (the 18 base fields).
      const base = result.root.objects().find((o) => o.name === "LlmCallBase");
      expect(base, "metaobjects::ai::LlmCallBase must be loaded via libraries").toBeDefined();
      baseFieldNames = base!.fields().map((f) => f.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Sanity: the shipped base really does declare 18 fields (catches a silent
    // library edit that drops/adds a column).
    expect(baseFieldNames).toHaveLength(18);

    // 3. The keys the generic recorder writes for a base row.
    const row = buildLlmCallRow(MINIMAL_INPUT);

    // 4. Set-equality — the gate. (Sorted arrays give a readable diff on failure.)
    const baseSet = [...baseFieldNames].sort();
    const rowSet = [...new Set(Object.keys(row))].sort();
    expect(rowSet).toEqual(baseSet);
  });
});
