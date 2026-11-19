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
  const procEntity = root.objects().find((o) => o.name === "StageSummary")!;
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
              name: "StageSummaryArgs",
              children: [
                { "field.int": { name: "consignmentId", "@required": true } },
                { "field.timestamp": { name: "asOfDate" } },
              ],
            },
          },
          {
            "object.projection": {
              name: "StageSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_stage_summary",
                    "@parameterRef": "StageSummaryArgs",
                  },
                },
                { "field.long": { name: "phaseId" } },
                { "field.string": { name: "phaseName" } },
              ],
            },
          },
        ],
      },
    });

    const out = renderCallableFile(procEntity);
    expect(out).toContain("export async function callStageSummary");
    expect(out).toContain("args: StageSummaryArgs");
    expect(out).toContain("fn_stage_summary");
    expect(out).toContain("args.consignmentId");
    expect(out).toContain("args.asOfDate");
    expect(out).toContain("Promise<StageSummary[]>");
  });

  test("tableFunction with @parameterRef emits the same shape with the @function name", async () => {
    const { procEntity } = await loadFirstEntity({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "StageSummaryArgs",
              children: [{ "field.int": { name: "id" } }],
            },
          },
          {
            "object.projection": {
              name: "StageSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "tableFunction",
                    "@function": "fn_phase_listing",
                    "@parameterRef": "StageSummaryArgs",
                  },
                },
                { "field.long": { name: "id" } },
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
            "object.projection": {
              name: "StageSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_ping",
                  },
                },
                { "field.long": { name: "id" } },
              ],
            },
          },
        ],
      },
    });
    const out = renderCallableFile(procEntity);
    expect(out).toContain("callStageSummary(db");
    expect(out).not.toContain("args:");
    expect(out).toContain("fn_ping()");
  });
});
