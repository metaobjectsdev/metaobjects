// Source v2 attribute schemas — registered by dbProvider for source.rdb.
// Consumed via sourceRdbAttrs in db-provider.ts.

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../../core/attr/attr-constants.js";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_ATTR_SCHEMA,
  SOURCE_ATTR_PARAMETER_REF,
  SOURCE_RDB_KINDS,
  SOURCE_ROLES,
} from "./source-constants.js";

/** `@table` — physical SQL table name for @kind: "table" (default). FR-016: one
 *  of five kind-aware physical-name aliases; all write to the same internal slot.
 *  Pre-1.0 legacy: also accepted with non-table @kind (canonical-serializer
 *  rewrites; loader emits WARN_LEGACY_PHYSICAL_NAME_ALIAS). */
const tableSchema: AttrSchema = {
  name: SOURCE_ATTR_TABLE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL table name for source.rdb @kind: \"table\" (default). FR-016: " +
    "Defaults from the source's bare structural `name` via the project's columnNamingStrategy " +
    "when omitted, then from the owning entity's name. Pre-1.0 legacy spelling for " +
    "view/materializedView/storedProc/tableFunction kinds during the transition; " +
    "canonical-serializer rewrites to the kind-matching alias.",
};

/** `@view` — physical SQL view name for @kind: "view" (FR-016 / ADR-0018). */
const viewSchema: AttrSchema = {
  name: SOURCE_ATTR_VIEW,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description: "Physical SQL view name for source.rdb @kind: \"view\". Same internal slot as @table.",
};

/** `@materializedView` — physical SQL materialized-view name for @kind: "materializedView". */
const materializedViewSchema: AttrSchema = {
  name: SOURCE_ATTR_MATERIALIZED_VIEW,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL materialized-view name for source.rdb @kind: \"materializedView\". Same internal slot as @table.",
};

/** `@proc` — physical SQL stored-procedure name for @kind: "storedProc". */
const procSchema: AttrSchema = {
  name: SOURCE_ATTR_PROC,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL stored-procedure name for source.rdb @kind: \"storedProc\". Same internal slot as @table.",
};

/** `@function` — physical SQL table-function name for @kind: "tableFunction". */
const functionSchema: AttrSchema = {
  name: SOURCE_ATTR_FUNCTION,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical SQL table-function name for source.rdb @kind: \"tableFunction\". Same internal slot as @table.",
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

/** `@parameterRef` — name or FQN of an object.value describing the input shape
 *  of a callable source (FR-015). Required when @kind is "storedProc" or
 *  "tableFunction" and the proc takes args; ignored for non-callable kinds.
 *  Mirrors template.@payloadRef from FR-004. */
const parameterRefSchema: AttrSchema = {
  name: SOURCE_ATTR_PARAMETER_REF,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "FR-015: name or FQN of an object.value describing the input shape of " +
    "this source's callable interface. Permitted on @kind: \"storedProc\" / " +
    "\"tableFunction\"; rejected on non-callable kinds (table / view / " +
    "materializedView). Field children of the referenced object.value become " +
    "the call-site parameter list in declaration order. Symmetric with " +
    "template.@payloadRef in FR-004 — the typed-input pattern reuses " +
    "object.value rather than minting a new parameter.* node type.",
};

/** All attr schemas for source.rdb, to be registered via registry.extend. */
export const sourceRdbAttrs: AttrSchema[] = [
  tableSchema,
  viewSchema,
  materializedViewSchema,
  procSchema,
  functionSchema,
  kindSchema,
  roleSchema,
  schemaSchema,
  parameterRefSchema,
];
