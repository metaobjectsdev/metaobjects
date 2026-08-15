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
import { loadCases, DEFAULT_VALIDATION_ENTITY } from "../src/validation-cases.ts";

type ParseFn = { safeParse(value: unknown): { success: boolean } };

/** Every corpus entity a case may name — each rendered through the real codegen
 *  template, so the gate covers the generator and not a hand-written schema. */
const ENTITY_NAMES = ["Account", "Ledger"] as const;

const insertSchemas = new Map<string, ParseFn>();
let tmpDir: string;

beforeAll(async () => {
  const root = await loadMetadataFile(join(VALIDATION_DIR, "meta.json"));
  const zodPath = pathToFileURL(Bun.resolveSync("zod", import.meta.dir)).href;
  tmpDir = mkdtempSync(join(tmpdir(), "validation-conformance-"));

  // Write EVERY module before importing ANY of them. Bun caches a directory's
  // listing at the first import out of it, so a sibling written after that import
  // is invisible to the resolver and fails with `Cannot find module <path>` even
  // though the file is on disk — which is exactly what a write-then-import loop
  // produced here (Account resolved, Ledger did not).
  const modulePaths: Array<readonly [string, string]> = [];
  for (const entityName of ENTITY_NAMES) {
    const entity = root.findObject(entityName);
    if (!entity) throw new Error(`corpus meta.json has no object named ${entityName}`);

    // Render the GENERATED InsertSchema (ts-poet Code → source string with imports).
    // Rewrite the bare `zod` import to an absolute resolved path so the module
    // resolves regardless of where the temp dir lives.
    let generated = renderInsertSchemaOnly(entity).toString();
    generated = generated.replace(/(['"])zod\1/g, JSON.stringify(zodPath));

    // Emit to a temp module (outside the package tree, so it can't be picked up by
    // a later test glob).
    const modulePath = join(tmpDir, `${entityName}.ts`);
    writeFileSync(modulePath, generated, "utf8");
    modulePaths.push([entityName, modulePath] as const);
  }

  for (const [entityName, modulePath] of modulePaths) {
    // Import so we exercise the real generated code.
    const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, ZodTypeAny>;
    const schema = mod[`${entityName}InsertSchema`];
    if (!schema) throw new Error(`generated module did not export ${entityName}InsertSchema`);
    insertSchemas.set(entityName, schema as unknown as ParseFn);
  }
});

describe("validation conformance — TS Zod reference runner", () => {
  for (const c of loadCases()) {
    test(c.name, () => {
      const entityName = c.entity ?? DEFAULT_VALIDATION_ENTITY;
      const schema = insertSchemas.get(entityName);
      if (!schema) throw new Error(`case "${c.name}" names unknown entity ${entityName}`);
      const result = schema.safeParse(c.payload);
      expect(
        result.success,
        `case "${c.name}": expected verdict valid=${c.expectValid} but generated ${entityName}InsertSchema returned valid=${result.success}`,
      ).toBe(c.expectValid);
    });
  }
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});
