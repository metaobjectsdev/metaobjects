// Source v2 attribute schemas — registered by dbProvider for source.rdb.
// Consumed via sourceRdbAttrs in db-provider.ts.

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../../core/attr/attr-constants.js";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_ATTR_SCHEMA,
  SOURCE_RDB_KINDS,
  SOURCE_ROLES,
} from "./source-constants.js";

/** `@table` — physical SQL table or view name for source.rdb. */
const tableSchema: AttrSchema = {
  name: SOURCE_ATTR_TABLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL table or view name for this rdb source. Defaults to the object name run through the project's columnNamingStrategy when omitted.",
};

/** `@kind` — object kind within the rdb paradigm; drives read-only derivation. */
const kindSchema: AttrSchema = {
  name: SOURCE_ATTR_KIND,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...SOURCE_RDB_KINDS],
  description:
    "The kind of database object this source represents: table (default, writable), view, materializedView, storedProc, or tableFunction. Non-table kinds are read-only.",
};

/** `@role` — multi-source role; exactly one primary per object. */
const roleSchema: AttrSchema = {
  name: SOURCE_ATTR_ROLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  allowedValues: [...SOURCE_ROLES],
  description:
    "Role this source plays when an object has multiple sources: primary (default, system of record), replica, index, cache, publish, or mirror.",
};

/** `@schema` — optional DB schema namespace for this source. */
const schemaSchema: AttrSchema = {
  name: SOURCE_ATTR_SCHEMA,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Optional database schema name (e.g. 'catalog', 'public'). Postgres defaults to 'public'; SQLite rejects any non-default value.",
};

/** All attr schemas for source.rdb, to be registered via registry.extend. */
export const sourceRdbAttrs: AttrSchema[] = [tableSchema, kindSchema, roleSchema, schemaSchema];
