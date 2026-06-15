// db-definition-completeness — proves the FR-033 S1.5-A data-driven db provider
// (spec/metamodel/db.json, read via applyProviderDefinition's `extends` path)
// lands EXACTLY the pre-S1.5 DB attrs on the right targets:
//   - @column / @db.indexed / @dbColumnType on EVERY field subtype;
//   - @storage on field.object ONLY;
//   - @autoSet on the temporal field subtypes (date/time/timestamp) ONLY;
//   - @table/@view/@materializedView/@proc/@function/@kind/@role/@schema/
//     @parameterRef on source.rdb.
//
// Composes core + db so the db extends apply on top of the core-registered types
// (the byte-identical-canonical proof is the registry-conformance gate; this is
// the focused per-target placement assertion).

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreTypesProvider } from "../src/core-types.js";
import { dbProvider } from "../src/persistence/db/db-provider.js";
import { TYPE_FIELD, TYPE_SOURCE } from "../src/shared/base-types.js";
import { FIELD_SUBTYPES } from "../src/core/field/field-constants.js";
import {
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../src/core/field/field-constants.js";
import { SOURCE_SUBTYPE_RDB } from "../src/persistence/source/source-constants.js";

const registry = composeRegistry([coreTypesProvider, dbProvider]);

function attrNames(type: string, subType: string): string[] {
  return registry.find(type, subType)!.attributes.map((a) => a.name);
}

const TEMPORAL = [FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIME, FIELD_SUBTYPE_TIMESTAMP] as const;

describe("db provider (data-driven) — attr placement", () => {
  for (const subType of FIELD_SUBTYPES) {
    test(`field.${subType} — @column / @db.indexed / @dbColumnType present`, () => {
      const names = attrNames(TYPE_FIELD, subType);
      expect(names).toContain("column");
      expect(names).toContain("db.indexed");
      expect(names).toContain("dbColumnType");
    });
  }

  test("@storage is on field.object ONLY", () => {
    expect(attrNames(TYPE_FIELD, FIELD_SUBTYPE_OBJECT)).toContain("storage");
    for (const subType of FIELD_SUBTYPES) {
      if (subType === FIELD_SUBTYPE_OBJECT) continue;
      expect(attrNames(TYPE_FIELD, subType)).not.toContain("storage");
    }
  });

  test("@autoSet is on the temporal field subtypes ONLY", () => {
    for (const subType of TEMPORAL) {
      expect(attrNames(TYPE_FIELD, subType)).toContain("autoSet");
    }
    for (const subType of FIELD_SUBTYPES) {
      if ((TEMPORAL as readonly string[]).includes(subType)) continue;
      expect(attrNames(TYPE_FIELD, subType)).not.toContain("autoSet");
    }
  });

  test("source.rdb carries the full DB source attr set", () => {
    const names = attrNames(TYPE_SOURCE, SOURCE_SUBTYPE_RDB);
    for (const expected of [
      "table",
      "view",
      "materializedView",
      "proc",
      "function",
      "kind",
      "role",
      "schema",
      "parameterRef",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("@dbColumnType description renders the legal-value list", () => {
    const attr = registry.find(TYPE_FIELD, "string")!.attributes.find((a) => a.name === "dbColumnType")!;
    expect(attr.description).toContain("uuid | jsonb | timestamp_with_tz");
  });
});
