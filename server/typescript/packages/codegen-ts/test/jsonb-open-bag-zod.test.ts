// `field.string` + `@dbColumnType: jsonb` is the sanctioned "open JSON bag"
// escape hatch (a genuinely untyped JSON column — there is no value-object to
// reference, and the loader rejects a bare `field.object` without @objectRef,
// directing authors here). Its Drizzle column is `jsonb()`, which node-postgres
// returns as a PARSED JS value (object/array/scalar) — NOT a string. So the
// generated Zod must be `z.unknown()`, not `z.string()`: a `z.string()` schema
// 400-rejects the real object on insert and fails the same schema on read-back,
// and it contradicts the native-object runtime-return contract (ADR-0019).
//
// Regression guard for the jsonb→Zod codegen bug found via an adopter audit.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { MetaDataLoader, FIELD_SUBTYPE_STRING, FIELD_ATTR_DB_COLUMN_TYPE, DB_COLUMN_TYPE_JSONB } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { renderEntityFile } from "../src/templates/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { fieldTsTypeString } from "../src/templates/inferred-types.js";
import { metaField } from "./_meta-build.js";

const YAML = `metadata:
  package: t
  children:
  - object.entity:
      name: Doc
      children:
      - source.rdb: { table: doc }
      - field.long: { name: id }
      - field.string: { name: payload, dbColumnType: jsonb }
      - field.string: { name: title }
      - identity.primary: { fields: [id], generation: increment }
`;

async function loadDoc() {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "jsonb-zod-"));
  const f = join(dir, "doc.yaml");
  writeFileSync(f, YAML);
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(f)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect: "postgres", loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return renderEntityFile(res.root.findObject("Doc")!, ctx).toString();
}

describe("field.string + @dbColumnType: jsonb → Zod z.unknown() (open JSON bag)", () => {
  test("Drizzle column is jsonb() (object-returning) — establishes the contract", async () => {
    const out = await loadDoc();
    expect(out).toContain('payload: jsonb("payload")');
  });

  test("Zod Insert/Update schema for the jsonb field is z.unknown(), NOT z.string()", async () => {
    const out = await loadDoc();
    expect(out).toContain("payload: z.unknown()");
    // The bug was z.string() — the Drizzle column and the Zod disagreed.
    expect(out).not.toContain("payload: z.string()");
  });

  test("a plain field.string (no jsonb override) is unaffected — still z.string()", async () => {
    const out = await loadDoc();
    expect(out).toContain("title: z.string()");
  });

  // The TS-type emitter must stay in lock-step with the Zod emitter (the
  // inferred-types contract): a jsonb-bag field is `unknown`, not `string`,
  // so a contract-only (runtime:false) target's TS type matches its Zod.
  test("fieldTsTypeString: field.string + @dbColumnType:jsonb → 'unknown' (not 'string')", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "payload");
    f.setAttr(FIELD_ATTR_DB_COLUMN_TYPE, DB_COLUMN_TYPE_JSONB);
    expect(fieldTsTypeString("Doc", f)).toBe("unknown");

    const plain = metaField(FIELD_SUBTYPE_STRING, "title");
    expect(fieldTsTypeString("Doc", plain)).toBe("string");
  });
});
