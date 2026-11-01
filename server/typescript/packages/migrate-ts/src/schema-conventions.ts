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
 * supplied as an object by the project (`migrate.conventions` in `metaobjects.config.ts`).
 * `default` is what migrate has always emitted, so a project that sets nothing sees no
 * change; `efcore` reproduces EF Core's conventions, for a database first built by EF
 * Core migrations.
 */

/** A key on one table: the table's database name and the key's columns, in key order. */
export interface KeyContext {
  table: string;
  columns: readonly string[];
}

/** A foreign key: its own columns, and the table and columns it references. */
export interface ForeignKeyContext extends KeyContext {
  refTable: string;
  refColumns: readonly string[];
}

/** What a table already has that may already serve as a foreign key's index. */
export interface ExistingKeys {
  primaryKey: readonly string[];
  indexes: readonly { columns: readonly string[]; where?: string; expr?: string }[];
}

export interface SchemaConventions {
  /** Shown in diagnostics; a preset's name, or the project's own. */
  readonly id: string;
  primaryKeyName(key: KeyContext): string;
  /** Used when the identity.reference declares no `@constraintName`. */
  foreignKeyName(fk: ForeignKeyContext): string;
  /** The index a foreign key gets, or undefined for none. */
  foreignKeyIndex(fk: ForeignKeyContext, existing: ExistingKeys): { name: string } | undefined;
  /** How a unique key (`identity.secondary`) is created. A partial or expression key is always an index. */
  uniqueKeyKind(key: KeyContext & { referencedByForeignKey: boolean }): "index" | "constraint";
}

/** Postgres's identifier limit (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63;

/** EF Core's truncation: a name over the limit keeps its first 62 characters and ends in `~`. */
function efTruncate(name: string): string {
  return name.length <= MAX_IDENTIFIER_LENGTH ? name : `${name.slice(0, MAX_IDENTIFIER_LENGTH - 1)}~`;
}

/** True when `columns` are the leading columns of `key`, in order. */
function startsWith(key: readonly string[], columns: readonly string[]): boolean {
  return columns.length > 0 && columns.length <= key.length && columns.every((c, i) => key[i] === c);
}

export const defaultConventions: SchemaConventions = {
  id: "default",
  primaryKeyName: ({ table }) => `${table}_pkey`,
  foreignKeyName: ({ table, columns }) => `${table}_${columns[0]}_fk`,
  foreignKeyIndex: () => undefined,
  uniqueKeyKind: () => "index",
};

export const efcoreConventions: SchemaConventions = {
  id: "efcore",
  primaryKeyName: ({ table }) => efTruncate(`PK_${table}`),
  foreignKeyName: ({ table, columns, refTable }) => efTruncate(`FK_${table}_${refTable}_${columns.join("_")}`),
  // EF Core indexes every foreign key unless a key or index already starts with its columns.
  foreignKeyIndex: (fk, existing) => {
    if (startsWith(existing.primaryKey, fk.columns)) return undefined;
    const covered = existing.indexes.some((ix) => ix.where === undefined && ix.expr === undefined && startsWith(ix.columns, fk.columns));
    return covered ? undefined : { name: efTruncate(`IX_${fk.table}_${fk.columns.join("_")}`) };
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
  if (typeof selected !== "string") return selected;
  const preset = PRESETS[selected];
  if (preset === undefined) {
    throw new Error(`unknown schema conventions "${selected}": expected one of ${SCHEMA_CONVENTION_PRESETS.join(", ")}`);
  }
  return preset;
}
