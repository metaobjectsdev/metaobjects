// FR-015 — @parameterRef on source.rdb for typed callable inputs.
// Loader-level tests: constant export, attr-schema registration, validation
// (UNRESOLVED, NOT_VALUE_OBJECT, ON_NON_CALLABLE_KIND, PASSTHROUGH_TYPE_MISMATCH).

import { describe, expect, test } from "bun:test";
import { SOURCE_ATTR_PARAMETER_REF } from "../src/persistence/source/source-constants.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ERROR_CODES } from "../src/errors.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

describe("FR-015 constants + error codes", () => {
  test("SOURCE_ATTR_PARAMETER_REF exported as 'parameterRef'", () => {
    expect(SOURCE_ATTR_PARAMETER_REF).toBe("parameterRef");
  });

  test("ERR_PARAMETER_REF_UNRESOLVED registered", () => {
    expect(ERROR_CODES).toContain("ERR_PARAMETER_REF_UNRESOLVED");
  });

  test("ERR_PARAMETER_REF_NOT_VALUE_OBJECT registered", () => {
    expect(ERROR_CODES).toContain("ERR_PARAMETER_REF_NOT_VALUE_OBJECT");
  });

  test("ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND registered", () => {
    expect(ERROR_CODES).toContain("ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND");
  });

  test("ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH registered", () => {
    expect(ERROR_CODES).toContain("ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH");
  });
});

describe("FR-015 happy paths", () => {
  test("storedProc with @parameterRef pointing at an object.value loads cleanly", async () => {
    const { errors } = await load({
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
            // FR-024 (B4b): proc-result shapes are object.projection (read-only,
            // external assembly); identity dropped (optional; no base entity here).
            "object.projection": {
              name: "PhaseSummary",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_get_phase_summary",
                    "@parameterRef": "PhaseSummaryArgs",
                  },
                },
                { "field.long": { name: "phaseId" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("storedProc WITHOUT @parameterRef loads cleanly (zero-arg proc)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.projection": {
              name: "Ping",
              children: [
                { "source.rdb": { "@kind": "storedProc", "@proc": "fn_ping" } },
                { "field.long": { name: "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("tableFunction with @parameterRef loads cleanly", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "ListArgs",
              children: [{ "field.int": { name: "limit" } }],
            },
          },
          {
            "object.projection": {
              name: "Listing",
              children: [
                {
                  "source.rdb": {
                    "@kind": "tableFunction",
                    "@function": "fn_listing",
                    "@parameterRef": "ListArgs",
                  },
                },
                { "field.long": { name: "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("FR-015 ERR_PARAMETER_REF_UNRESOLVED", () => {
  test("@parameterRef pointing at non-existent name errors", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "BrokenProc",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_x",
                    "@parameterRef": "NonexistentArgs",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_PARAMETER_REF_UNRESOLVED");
  });
});

describe("FR-015 ERR_PARAMETER_REF_NOT_VALUE_OBJECT", () => {
  test("@parameterRef pointing at an object.entity errors", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "source.rdb": { "@table": "customers" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "ProcUsingEntityAsArgs",
              children: [
                {
                  "source.rdb": {
                    "@kind": "storedProc",
                    "@proc": "fn_x",
                    "@parameterRef": "Customer",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_PARAMETER_REF_NOT_VALUE_OBJECT");
  });
});

describe("FR-015 ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND", () => {
  test("@parameterRef set with @kind: 'table' errors", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "Args",
              children: [{ "field.int": { name: "x" } }],
            },
          },
          {
            "object.entity": {
              name: "RegularTable",
              children: [
                {
                  "source.rdb": {
                    "@table": "regular_table",
                    "@parameterRef": "Args",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND");
  });

  test("@parameterRef set with @kind: 'view' errors", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "Args",
              children: [{ "field.int": { name: "x" } }],
            },
          },
          {
            "object.entity": {
              name: "AView",
              children: [
                {
                  "source.rdb": {
                    "@kind": "view",
                    "@view": "v_x",
                    "@parameterRef": "Args",
                  },
                },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .toContain("ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND");
  });
});
