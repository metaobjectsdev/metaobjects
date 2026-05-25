import type { Kysely } from "kysely";
import type { Dialect, SchemaSnapshot } from "../types.js";
import { introspectPostgres } from "./postgres.js";
import { introspectSqlite } from "./sqlite.js";

export { introspectPostgres } from "./postgres.js";
export { introspectSqlite } from "./sqlite.js";

export async function introspect(db: Kysely<Record<string, unknown>>, dialect: Dialect): Promise<SchemaSnapshot> {
  switch (dialect) {
    case "postgres": return introspectPostgres(db);
    case "sqlite":   return introspectSqlite(db);
    case "d1":       throw new Error("d1 introspect goes through introspectD1, not introspect() — wrangler does not use a Kysely driver");
  }
}
