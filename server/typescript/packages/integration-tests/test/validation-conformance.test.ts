// Validation-conformance TS reference runner.
//
// TS (Zod) is the reference port: this test builds the GENERATED
// `AccountInsertSchema` from the corpus metadata via the real codegen template
// (`renderInsertSchemaOnly`), emits it to a temp .ts module, dynamically
// imports it, and `safeParse`s each corpus payload — asserting
// `result.success === case.expectValid`. The booleans pinned here are the
// single-source verdicts the other four ports assert against.
//
// We deliberately drive the GENERATED schema (codegen output), not a
// hand-written Zod schema, so the test gates the generator.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodTypeAny } from "zod";
import { renderInsertSchemaOnly } from "@metaobjectsdev/codegen-ts/templates/zod-validators";
import { VALIDATION_DIR } from "../src/paths.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadCases } from "../src/validation-cases.ts";

const ENTITY_NAME = "Account";

let insertSchema: { safeParse(value: unknown): { success: boolean } };
let tmpDir: string;

beforeAll(async () => {
  const root = await loadMetadataFile(join(VALIDATION_DIR, "meta.json"));
  const account = root.findObject(ENTITY_NAME);
  if (!account) throw new Error(`corpus meta.json has no object named ${ENTITY_NAME}`);

  // Render the GENERATED InsertSchema (ts-poet Code → source string with imports).
  let generated = renderInsertSchemaOnly(account).toString();

  // Emit to a temp module (outside the package tree, so it can't be picked up by
  // a later test glob) and import it so we exercise the real generated code.
  // Rewrite the bare `zod` import to an absolute resolved path so the module
  // resolves regardless of where the temp dir lives.
  const zodPath = pathToFileURL(Bun.resolveSync("zod", import.meta.dir)).href;
  generated = generated.replace(/(['"])zod\1/g, JSON.stringify(zodPath));

  tmpDir = mkdtempSync(join(tmpdir(), "validation-conformance-"));
  const modulePath = join(tmpDir, `${ENTITY_NAME}.ts`);
  writeFileSync(modulePath, generated, "utf8");

  const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, ZodTypeAny>;
  const schema = mod[`${ENTITY_NAME}InsertSchema`];
  if (!schema) throw new Error(`generated module did not export ${ENTITY_NAME}InsertSchema`);
  insertSchema = schema as unknown as { safeParse(value: unknown): { success: boolean } };
});

describe("validation conformance — TS Zod reference runner", () => {
  for (const c of loadCases()) {
    test(c.name, () => {
      const result = insertSchema.safeParse(c.payload);
      expect(
        result.success,
        `case "${c.name}": expected verdict valid=${c.expectValid} but generated AccountInsertSchema returned valid=${result.success}`,
      ).toBe(c.expectValid);
    });
  }
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});
