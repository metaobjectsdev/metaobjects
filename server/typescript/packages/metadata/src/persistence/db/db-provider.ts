// dbProvider — the DB-domain MetaDataTypeProvider. Registers the DB-domain
// attributes (@dbColumn, @db.indexed on fields; @name on source.dbTable /
// source.dbView) by extending the core-registered types. Mirrors Java's
// CoreDBMetaDataProvider (com.metaobjects.database).
// See docs/superpowers/specs/2026-05-18-phase4b-db-provider-design.md.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { TYPE_FIELD, TYPE_SOURCE } from "../../shared/base-types.js";
import { FIELD_SUBTYPES } from "../../core/field/field-constants.js";
import {
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
} from "../source/source-constants.js";
import { dbColumnSchema, dbIndexedSchema, sourceNameSchema } from "./db-attr-schemas.js";

export const dbProvider: MetaDataTypeProvider = {
  id: "metaobjects-db",
  dependencies: ["metaobjects-core-types"],
  description:
    "DB-domain attributes — @dbColumn / @db.indexed on fields, @name on source.dbTable / source.dbView.",
  registerTypes(registry: TypeRegistry): void {
    for (const subType of FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, {
        attributes: [dbColumnSchema, dbIndexedSchema],
      });
    }
    // Two explicit calls (not a loop) — dbTable and dbView are the only DB
    // source subtypes, and there is no DB_SOURCE_SUBTYPES constant to loop.
    registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_DB_TABLE, {
      attributes: [sourceNameSchema],
    });
    registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_DB_VIEW, {
      attributes: [sourceNameSchema],
    });
  },
};
