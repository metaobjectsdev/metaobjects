// dbProvider — the DB-domain MetaDataTypeProvider. Registers the DB-domain
// attributes (@column / @db.indexed on fields; @table/@kind/@role/@schema on
// source.rdb) by extending the core-registered types. Mirrors Java's
// CoreDBMetaDataProvider (com.metaobjects.database).

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { TYPE_FIELD, TYPE_SOURCE } from "../../shared/base-types.js";
import { FIELD_SUBTYPES } from "../../core/field/field-constants.js";
import { SOURCE_SUBTYPE_RDB } from "../source/source-constants.js";
import { columnSchema, dbIndexedSchema, dbColumnTypeSchema } from "./db-schema.js";
import { sourceRdbAttrs } from "../source/source-schema.js";

export const dbProvider: MetaDataTypeProvider = {
  id: "metaobjects-db",
  dependencies: ["metaobjects-core-types"],
  description:
    "DB-domain attributes — @column / @db.indexed / @dbColumnType on fields, @table/@kind/@role/@schema on source.rdb.",
  registerTypes(registry: TypeRegistry): void {
    for (const subType of FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, {
        attributes: [columnSchema, dbIndexedSchema, dbColumnTypeSchema],
      });
    }
    // source.rdb — @table/@kind/@role/@schema attrs.
    registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, {
      attributes: [...sourceRdbAttrs],
    });
  },
};
