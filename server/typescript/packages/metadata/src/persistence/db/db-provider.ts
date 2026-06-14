// dbProvider — the DB-domain MetaDataTypeProvider. Registers the DB-domain
// attributes (@column / @db.indexed on fields; @table/@kind/@role/@schema on
// source.rdb) by extending the core-registered types. Mirrors Java's
// CoreDBMetaDataProvider (com.metaobjects.database).

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { TYPE_FIELD, TYPE_SOURCE } from "../../shared/base-types.js";
import {
  FIELD_SUBTYPES,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../../core/field/field-constants.js";
import { SOURCE_SUBTYPE_RDB } from "../source/source-constants.js";
import {
  columnSchema,
  dbIndexedSchema,
  dbColumnTypeSchema,
  storageSchema,
  autoSetSchema,
} from "./db-schema.js";
import { sourceRdbAttrs } from "../source/source-schema.js";

/** Field subtypes that accept @autoSet — the temporal subtypes only (FR-033
 *  S1-field-B). @autoSet is a DB-write-time created/updated stamping concern,
 *  meaningless on a non-temporal field. */
const AUTO_SET_FIELD_SUBTYPES = [
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
] as const;

export const dbProvider: MetaDataTypeProvider = {
  id: "metaobjects-db",
  dependencies: ["metaobjects-core-types"],
  description:
    "DB-domain attributes — @column / @db.indexed / @dbColumnType on every field, @storage on field.object, @autoSet on temporal fields, @table/@kind/@role/@schema on source.rdb.",
  registerTypes(registry: TypeRegistry): void {
    // Universal column attrs — every field is a column on an rdb source.
    for (const subType of FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, {
        attributes: [columnSchema, dbIndexedSchema, dbColumnTypeSchema],
      });
    }
    // @storage — physical storage strategy, meaningful only on an object-typed
    // field (set with @objectRef). FR-033 S1-field-B scopes it to field.object.
    registry.extend(TYPE_FIELD, FIELD_SUBTYPE_OBJECT, {
      attributes: [storageSchema],
    });
    // @autoSet — created/updated stamping, only on the temporal field subtypes.
    for (const subType of AUTO_SET_FIELD_SUBTYPES) {
      registry.extend(TYPE_FIELD, subType, {
        attributes: [autoSetSchema],
      });
    }
    // source.rdb — @table/@kind/@role/@schema attrs.
    registry.extend(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, {
      attributes: [...sourceRdbAttrs],
    });
  },
};
