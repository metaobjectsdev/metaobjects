// Validation-conformance RUN-TIME runner (TS).
//
// The sibling `validation-conformance.test.ts` gates the GENERATED Zod schema. This one
// runs the same corpus through `runValidators` — the metadata-driven run-time runner the
// ObjectManager uses — so the two TS enforcement surfaces cannot drift, and asserts the
// exact failure list pinned in `runtime-errors.json`. The Python `run_validators` runner
// asserts the same file, which is what keeps the two run-time runners identical in
// structure and message text and not merely in verdict.

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { runValidators, type ValidationFailure } from "@metaobjectsdev/runtime-ts";
import { VALIDATION_DIR } from "../src/paths.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadCases, DEFAULT_VALIDATION_ENTITY } from "../src/validation-cases.ts";

const expectedErrors = (
  JSON.parse(readFileSync(join(VALIDATION_DIR, "runtime-errors.json"), "utf8")) as {
    errors: Record<string, ValidationFailure[]>;
  }
).errors;

let root: MetaRoot;

beforeAll(async () => {
  root = await loadMetadataFile(join(VALIDATION_DIR, "meta.json"));
});

describe("validation conformance — TS run-time runner (runValidators)", () => {
  const cases = loadCases();

  for (const c of cases) {
    test(c.name, () => {
      const entityName = c.entity ?? DEFAULT_VALIDATION_ENTITY;
      const entity = root.findObject(entityName);
      if (!entity) throw new Error(`case "${c.name}" names unknown entity ${entityName}`);
      const result = runValidators(entity, c.payload);
      expect(result.ok, `case "${c.name}": ${JSON.stringify(result)}`).toBe(c.expectValid);
      if (!result.ok) expect(result.errors).toEqual(expectedErrors[c.name] ?? []);
    });
  }

  test("runtime-errors.json pins exactly the rejected cases", () => {
    const rejected = cases.filter((c) => !c.expectValid).map((c) => c.name).sort();
    expect(Object.keys(expectedErrors).sort()).toEqual(rejected);
  });
});
