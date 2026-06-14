// dbProvider — the DB-domain MetaDataTypeProvider. Registers the DB-domain
// attributes (@column / @db.indexed / @dbColumnType + @storage on field.object,
// @autoSet on temporal fields; @table/@kind/@role/@schema/... on source.rdb) by
// EXTENDING the core-registered types. Mirrors Java's CoreDBMetaDataProvider
// (com.metaobjects.database).
//
// FR-033 S1.5-A: the attrs + their descriptions are now DATA — read from
// spec/metamodel/db.json (embedded as DB_DEFINITION) via the unified
// applyProviderDefinition apply path's `extends` handling. The provider declares
// no new types, so the factory map is empty.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { applyProviderDefinition } from "../../provider-data.js";
import { DB_DEFINITION } from "./db-definition.embedded.js";

export const dbProvider: MetaDataTypeProvider = {
  id: "metaobjects-db",
  dependencies: ["metaobjects-core-types"],
  description:
    "DB-domain attributes — @column / @db.indexed / @dbColumnType on every field, @storage on field.object, @autoSet on temporal fields, @table/@kind/@role/@schema on source.rdb.",
  registerTypes(registry: TypeRegistry): void {
    applyProviderDefinition(registry, DB_DEFINITION, {});
  },
};
