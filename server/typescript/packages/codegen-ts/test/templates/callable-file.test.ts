// FR-015 — codegen-ts callable-file emission test.
// Generated wrapper for an entity backed by a stored procedure or table
// function: typed args (from @parameterRef object.value) + projection return.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
} from "@metaobjectsdev/metadata";
import { renderCallableFile } from "../../src/templates/callable-file.js";

async function loadFirstEntity(doc: unknown) {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "demo.json" }),
  ]);
  if (errors.length > 0) throw new Error(`load errors: ${errors.map((e) => e.message).join("; ")}`);
  const procEntity = root.objects().find((o) => o.name === "PhaseSummary")!;
  return { root, procEntity };
}

describe("renderCallableFile", () => {
  test("storedProc with @parameterRef emits typed wrapper function", async () => {
    const { procEntity } = await loadFirstEntity({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "PhaseSummaryArgs",
              children: [
                { "field.int": { name: "caseId", "@required": true } },
                { "field.timestamp": { name: "asOfDate" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "PhaseSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_phase_summary",
                    "@parameterRef": "PhaseSummaryArgs",
                  },
                },
                { "field.long": { name: "phaseId" } },
                { "field.string": { name: "phaseName" } },
                { "identity.primary": { "@fields": "phaseId" } },
              ],
            },
          },
        ],
      },
    });

    const out = renderCallableFile(procEntity);
    expect(out).toContain("export async function callPhaseSummary");
    expect(out).toContain("args: PhaseSummaryArgs");
    expect(out).toContain("fn_phase_summary");
    expect(out).toContain("args.caseId");
    expect(out).toContain("args.asOfDate");
    expect(out).toContain("Promise<PhaseSummary[]>");
  });

  test("tableFunction with @parameterRef emits the same shape with the @function name", async () => {
    const { procEntity } = await loadFirstEntity({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "PhaseSummaryArgs",
              children: [{ "field.int": { name: "id" } }],
            },
          },
          {
            "object.entity": {
              name: "PhaseSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "tableFunction",
                    "@function": "fn_phase_listing",
                    "@parameterRef": "PhaseSummaryArgs",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const out = renderCallableFile(procEntity);
    expect(out).toContain("fn_phase_listing");
    expect(out).toContain("args.id");
  });

  test("storedProc with NO @parameterRef emits a zero-arg wrapper", async () => {
    const { procEntity } = await loadFirstEntity({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "PhaseSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_ping",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const out = renderCallableFile(procEntity);
    expect(out).toContain("callPhaseSummary(db");
    expect(out).not.toContain("args:");
    expect(out).toContain("fn_ping()");
  });
});
