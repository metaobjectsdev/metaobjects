/**
 * Schema conventions: the names and physical choices for database objects that NO CODE
 * ADDRESSES — primary-key and foreign-key constraint names, whether a foreign key gets an
 * index and what it is called, and whether a unique key is created as an index or a
 * constraint.
 *
 * Names that code does address — tables, views, columns, and any constraint or index a
 * program compares against — are not decided here. They resolve in core naming
 * (`naming` in `.metaobjects/config.json`) and from metadata overrides, the same in every
 * port. A metadata override always beats a convention: `@constraintName` on an
 * `identity.reference`, and an index node's own name.
 *
 * Selected with `migrate.conventions` in `.metaobjects/config.json` (a preset name), or
 * supplied as an object by the project (`schemaConventions` in `metaobjects.config.ts`).
 * `default` is what migrate has always emitted, so a project that sets nothing sees no
 * change; `efcore` reproduces EF Core's conventions, for a database first built by EF
 * Core migrations.
 *
 * Which CHECKs exist is not a convention: that is the project's `migrate.checks` setting,
 * passed to the expected-schema build as `skipRedundantChecks`.
 */

import { InvalidSchemaConventionsError, UnknownSchemaConventionsError } from "./errors.js";
import type { Dialect, IndexDescriptor } from "./types.js";

/** A key on one table: the table's database name and the key's columns, in key order, and the
 *  database the schema is built for (undefined is Postgres, as elsewhere in migrate). */
export interface KeyContext {
  table: string;
  columns: readonly string[];
  dialect?: Dialect | undefined;
}

/** A foreign key: its own columns, and the table and columns it references. */
export interface ForeignKeyContext extends KeyContext {
  refTable: string;
  refColumns: readonly string[];
}

/** A table as the FK-index decision sees it: its keys, its declared indexes, its foreign keys. */
export interface TableKeys {
  table: string;
  dialect?: Dialect | undefined;
  primaryKey: readonly string[];
  /** The indexes the model declares (unique keys included); the conventions add to these. */
  indexes: readonly { columns: readonly string[]; where?: string; expr?: string }[];
  foreignKeys: readonly ForeignKeyContext[];
}

export interface SchemaConventions {
  /** Shown in diagnostics; a preset's name, or the project's own. */
  readonly id: string;
  primaryKeyName(key: KeyContext): string;
  /** Used when the identity.reference declares no `@constraintName`. */
  foreignKeyName(fk: ForeignKeyContext): string;
  /** The indexes the conventions add for a table's foreign keys (none, for most conventions). */
  foreignKeyIndexes(table: TableKeys): { name: string; columns: string[] }[];
  /** How a unique key (`identity.secondary`) is created. A partial or expression key is always an index. */
  uniqueKeyKind(key: KeyContext & { referencedByForeignKey: boolean }): "index" | "constraint";
}

/** Postgres's identifier limit (NAMEDATALEN - 1), which Npgsql gives EF Core. */
const PG_MAX_IDENTIFIER_LENGTH = 63;

/**
 * EF Core's truncation: a name over the provider's identifier limit keeps one character fewer
 * than the limit and ends in `~`. Only Postgres has a limit here; EF Core's SQLite provider
 * truncates nothing, so neither does this on SQLite or D1.
 */
function efTruncate(name: string, dialect: Dialect | undefined): string {
  if (dialect === "sqlite" || dialect === "d1") return name;
  return name.length <= PG_MAX_IDENTIFIER_LENGTH ? name : `${name.slice(0, PG_MAX_IDENTIFIER_LENGTH - 1)}~`;
}

/** True when `columns` are the leading columns of `key`, in order. */
function startsWith(key: readonly string[], columns: readonly string[]): boolean {
  return columns.length > 0 && columns.length <= key.length && columns.every((c, i) => key[i] === c);
}

export const defaultConventions: SchemaConventions = {
  id: "default",
  primaryKeyName: ({ table }) => `${table}_pkey`,
  foreignKeyName: ({ table, columns }) => `${table}_${columns[0]}_fk`,
  foreignKeyIndexes: () => [],
  uniqueKeyKind: () => "index",
};

export const efcoreConventions: SchemaConventions = {
  id: "efcore",
  primaryKeyName: ({ table, dialect }) => efTruncate(`PK_${table}`, dialect),
  foreignKeyName: ({ table, columns, refTable, dialect }) => efTruncate(`FK_${table}_${refTable}_${columns.join("_")}`, dialect),
  // EF Core's ForeignKeyIndexConvention: every foreign key gets an index unless a key or
  // another index already starts with its columns. Its AreIndexedBy compares property lists
  // only — a filter is a relational annotation the convention never sees, so a partial index
  // covers — and an index added later removes a convention index it covers, so the result
  // does not depend on the order the foreign keys are declared in.
  foreignKeyIndexes: (t) => {
    const candidates: string[][] = [];
    for (const fk of t.foreignKeys) {
      const columns = [...fk.columns];
      if (startsWith(t.primaryKey, columns)) continue;
      if (t.indexes.some((ix) => ix.expr === undefined && startsWith(ix.columns, columns))) continue;
      if (candidates.some((c) => c.length === columns.length && startsWith(c, columns))) continue;
      candidates.push(columns);
    }
    return candidates
      .filter((c) => !candidates.some((o) => o.length > c.length && startsWith(o, c)))
      .map((columns) => ({ name: efTruncate(`IX_${t.table}_${columns.join("_")}`, t.dialect), columns }));
  },
  // An alternate key (one an FK references) is a UNIQUE constraint; any other unique key is an index.
  uniqueKeyKind: ({ referencedByForeignKey }) => (referencedByForeignKey ? "constraint" : "index"),
};

const PRESETS: Readonly<Record<string, SchemaConventions>> = {
  [defaultConventions.id]: defaultConventions,
  [efcoreConventions.id]: efcoreConventions,
};

/** The preset names `migrate.conventions` accepts in `.metaobjects/config.json`. */
export const SCHEMA_CONVENTION_PRESETS = Object.keys(PRESETS) as readonly string[];

/** A preset by name, a project-supplied object as itself, and nothing as `default`. */
export function resolveSchemaConventions(selected: string | SchemaConventions | undefined): SchemaConventions {
  if (selected === undefined) return defaultConventions;
  if (typeof selected !== "string") {
    const members = ["primaryKeyName", "foreignKeyName", "foreignKeyIndexes", "uniqueKeyKind"] as const;
    const missing = members.filter((m) => typeof (selected as unknown as Record<string, unknown>)[m] !== "function");
    const id = String((selected as { id?: unknown }).id ?? "(no id)");
    if (missing.length > 0) throw new InvalidSchemaConventionsError(id, missing);
    // Moved to `migrate.checks.skipRedundant`: a conventions object still setting it would
    // otherwise be silently ignored and bring every redundant CHECK back as drift.
    if ("skipRedundantChecks" in (selected as object)) throw new InvalidSchemaConventionsError(id, [], ["skipRedundantChecks"]);
    return selected;
  }
  const preset = PRESETS[selected];
  if (preset === undefined) throw new UnknownSchemaConventionsError(selected, SCHEMA_CONVENTION_PRESETS);
  return preset;
}

/** A unique key a `UNIQUE` constraint can express: plain ascending btree columns, no predicate. */
export function canBeUniqueConstraint(ix: IndexDescriptor): boolean {
  return ix.unique && ix.where === undefined && ix.expr === undefined
    && (ix.using === undefined || ix.using === "btree")
    && (ix.orders === undefined || ix.orders.every((o) => o === "asc"));
}
