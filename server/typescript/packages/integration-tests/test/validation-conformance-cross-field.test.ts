// Cross-field validation-conformance, TS (Zod) reference runner.
//
// Renders the GENERATED `EventInsertSchema` and `ShiftInsertSchema` (validator.comparison /
// requiredWhen / presentIff / atLeastOne / exactlyOne, each with or without an @condition,
// enforced as a refinement) through the real codegen template
// into a temp module, then safeParses every cross-field-cases.json payload.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodTypeAny } from "zod";
import { renderZodValidators } from "@metaobjectsdev/codegen-ts/templates/zod-validators";
import { VALIDATION_DIR } from "../src/paths.ts";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadCrossFieldCases } from "../src/validation-cases.ts";

type ParseFn = { safeParse(value: unknown): { success: boolean } };

const ENTITY_NAMES = ["Event", "Shift"] as const;
const insertSchemas = new Map<string, ParseFn>();
let updateSchema: ParseFn;
let tmpDir: string;

beforeAll(async () => {
  const root = await loadMetadataFile(join(VALIDATION_DIR, "meta.cross-field.json"));
  const zodPath = pathToFileURL(Bun.resolveSync("zod", import.meta.dir)).href;
  tmpDir = mkdtempSync(join(tmpdir(), "validation-cross-field-"));
  const modulePaths: Array<readonly [string, string]> = [];
  for (const name of ENTITY_NAMES) {
    const entity = root.findObject(name);
    if (!entity) throw new Error(`cross-field meta has no object named ${name}`);
    const generated = renderZodValidators(entity).toString().replace(/(['"])zod\1/g, JSON.stringify(zodPath));
    const modulePath = join(tmpDir, `${name}.ts`);
    writeFileSync(modulePath, generated, "utf8");
    modulePaths.push([name, modulePath] as const);
  }
  for (const [name, modulePath] of modulePaths) {
    const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, ZodTypeAny>;
    const schema = mod[`${name}InsertSchema`];
    if (!schema) throw new Error(`generated module did not export ${name}InsertSchema`);
    insertSchemas.set(name, schema as unknown as ParseFn);
    if (name === "Event") updateSchema = mod[`${name}UpdateSchema`] as unknown as ParseFn;
  }
});

describe("cross-field validation conformance — TS Zod reference runner", () => {
  for (const c of loadCrossFieldCases()) {
    test(c.name, () => {
      const entityName = c.entity ?? "Event";
      const schema = insertSchemas.get(entityName);
      if (!schema) throw new Error(`case "${c.name}" names unknown entity ${entityName}`);
      expect(
        schema.safeParse(c.payload).success,
        `case "${c.name}": expected valid=${c.expectValid}`,
      ).toBe(c.expectValid);
    });
  }

  test("the PATCH schema never enforces cross-field rules (a partial body cannot see the merged row)", () => {
    // Violates comparison, requiredWhen, presentIff and atLeastOne at once.
    expect(updateSchema.safeParse({ startsAt: 9, endsAt: 1, kind: "BIRTH", state: "CLOSED" }).success).toBe(true);
    expect(updateSchema.safeParse({}).success).toBe(true);
  });
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});
