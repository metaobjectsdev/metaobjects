import type { AllowOptions, Change, ChangeKind } from "./types.js";
import { dropsAutoSequenceDefault } from "./pg-identity-default.js";
import { suggestColumnRenames, type ColumnRenameSuggestion } from "./diff/rename-suggestions.js";

// ---------------------------------------------------------------------------
// SetNullNotNullableError — surfaced by buildExpectedSchema
// ---------------------------------------------------------------------------

/**
 * Thrown when a foreign key's resolved ON DELETE action is "set-null" but one
 * or more of its FK columns map to a NOT NULL field (@required: true).
 *
 * ON DELETE SET NULL requires the FK column(s) to be nullable — Postgres and
 * SQLite both reject the combination at DDL execution time.
 *
 * Fix: either remove @required from the FK field(s), or override the
 * relationship with @onDelete: "restrict" / "no-action" to avoid set-null.
 */
export class SetNullNotNullableError extends Error {
  override readonly name = "SetNullNotNullableError";
  readonly entityName: string;
  readonly constraintName: string;
  readonly offendingFields: string[];

  constructor(entityName: string, constraintName: string, offendingFields: string[]) {
    const fieldList = offendingFields.join(", ");
    super(
      `Entity "${entityName}": FK constraint "${constraintName}" uses ON DELETE SET NULL ` +
      `but field(s) [${fieldList}] are NOT NULL (@required: true). ` +
      `Fix: remove @required from the FK field(s), or override with @onDelete: "restrict" / "no-action" on the relationship.`,
    );
    this.entityName = entityName;
    this.constraintName = constraintName;
    this.offendingFields = offendingFields;
  }
}

/** One identity.reference whose target fields are not a unique key on the table it references. */
export interface FkTargetViolation {
  /** The holder's table, qualified (`<schema>.<table>`): what `scopeExpectedSchema` governs by. */
  table: string;
  entityName: string;
  referenceName: string;
  targetEntityName: string;
  targetFields: string[];
  /** Set when the target is a TPH subtype: the entity whose table it is stored in. */
  storedIn?: string;
}

/**
 * Thrown by buildExpectedSchema() when one or more identity.references target fields the
 * target table does not hold unique: not its primary key, not a plain identity.secondary,
 * not a single @unique field. A database refuses such an FK at apply time, after earlier
 * statements in the migration already ran; refusing here names every offending reference
 * at once, so a model with several is fixed in one pass rather than one run per reference.
 */
export class FkTargetNotUniqueError extends Error {
  override readonly name = "FkTargetNotUniqueError";
  readonly violations: FkTargetViolation[];

  constructor(violations: FkTargetViolation[]) {
    const lines = violations.map((v) => {
      const fieldList = v.targetFields.join(", ");
      const head = `Entity "${v.entityName}": reference "${v.referenceName}" targets [${fieldList}] on "${v.targetEntityName}", ` +
        `which is not a unique key of its table (its primary key, an identity.secondary without @where/@expr, or a @unique field). `;
      return v.storedIn !== undefined
        ? head + `"${v.targetEntityName}" is stored in the table of "${v.storedIn}", and a key declared on a TPH subtype is not emitted: ` +
          `declare it on "${v.storedIn}" (an identity.secondary with @fields [${fieldList}]).`
        : head + `Fix: declare an identity.secondary on "${v.targetEntityName}" with @fields [${fieldList}], or reference its whole primary key.`;
    });
    const head = violations.length === 1
      ? "A database refuses this foreign key."
      : `A database refuses these ${violations.length} foreign keys.`;
    super(`${head}\n${lines.map((l) => `  - ${l}`).join("\n")}`);
    this.violations = violations;
  }
}

const ALLOW_OPTION_BY_KIND: Partial<Record<ChangeKind, keyof AllowOptions>> = {
  "drop-column": "dropColumn",
  "drop-table": "dropTable",
  "change-column-type": "typeChange",
  "change-column-nullable": "nullableToNotNull",
  "drop-index": "dropIndex",
  "drop-fk": "dropFk",
  "drop-check": "dropCheck",
  // change-column-default is blocked in exactly one shape — dropping a live
  // Postgres auto-sequence default with no declared @generation (see
  // diff/status.ts) — and allow.dropIdentityDefault is the flag that enables it.
  "change-column-default": "dropIdentityDefault",
  "change-column-identity": "dropIdentityDefault",
};

/**
 * The `AllowOptions` field that unblocks `c`, chosen by what BLOCKED it rather than by its kind
 * alone: `diff` records the gate that refused the change on its status (`blockedBy`), and one
 * change can sit behind several gates in turn (a view drop: cascade, then adoption, then the
 * removal itself). A status that records no gate falls back to the change's kind, where a type
 * change carries its column's default change, so one that would drop a live auto-sequence
 * default is blocked by THAT, and `typeChange` would not unblock it. The single source for this
 * error's hints and the CLI's `--allow` token.
 */
export function allowOptionFor(c: Change): keyof AllowOptions | undefined {
  if (c.status.blockedBy !== undefined) return c.status.blockedBy;
  if (c.kind === "change-column-type" && dropsAutoSequenceDefault(c.fromDefault, c.toDefault)) {
    return "dropIdentityDefault";
  }
  return ALLOW_OPTION_BY_KIND[c.kind];
}

function changeLocator(c: Change): string {
  switch (c.kind) {
    case "drop-column":
    case "rename-column":
    case "change-column-type":
    case "change-column-nullable":
    case "change-column-default":
    case "change-column-identity":
    case "alter-sequence":
      return `${c.table}.${"column" in c ? c.column : c.from}`;
    case "change-comment":
      return c.column !== undefined ? `${c.table}.${c.column}` : c.table;
    case "add-column":
      return `${c.table}.${c.column.name}`;
    case "drop-table":
    case "rename-table":
      return c.kind === "drop-table" ? c.table : `${c.from}→${c.to}`;
    case "rename-constraints":
      return `${c.table}: ${[...(c.constraintRenames ?? []), ...(c.indexRenames ?? [])].map((r) => `${r.from}→${r.to}`).join(", ")}`;
    case "create-table":
      return c.table.name;
    case "add-index":
      return `${c.table}.${c.index.name}`;
    case "drop-index":
      return `${c.table}.${c.index}`;
    case "add-fk":
      return `${c.table}.${c.fk.name}`;
    case "drop-fk":
      return `${c.table}.${c.fk}`;
    case "add-check":
      return `${c.table}.${c.check.name}`;
    case "drop-check":
      return `${c.table}.${c.check}`;
    case "create-view":
    case "replace-view":
      return c.view.name;
    case "drop-view":
      return c.view;
  }
}

function renameFor(
  renames: readonly ColumnRenameSuggestion[],
  c: Extract<Change, { kind: "drop-column" }>,
): ColumnRenameSuggestion | undefined {
  return renames.find((r) => r.from === c.column && r.table === c.table && r.schema === c.schema);
}

function renameHint(c: Extract<Change, { kind: "drop-column" }>, r: ColumnRenameSuggestion): string {
  const schema = r.schema !== undefined ? `, schema: "${r.schema}"` : "";
  const declared = `{ kind: "column", table: "${r.table}"${schema}, from: "${r.from}", to: "${r.to}" }`;
  const shape = r.shapeChange !== undefined
    ? ` (its ${r.shapeChange} also changes: declare the rename with the old shape first, then change the shape in a second migration)`
    : "";
  return `drop-column on ${changeLocator(c)}: if it was renamed to ${r.table}.${r.to}, keep its data by `
    + `declaring renames: [${declared}]${shape}; pass allow.dropColumn only to DELETE the column and its data`;
}

export class BlockedChangesError extends Error {
  override readonly name = "BlockedChangesError";
  readonly blocked: Change[];
  readonly enableHints: string[];

  /**
   * @param changes the whole change list the blocked ones came from. With it, a blocked
   *   drop-column that pairs with an add-column in the same table is hinted as the rename
   *   it may be — the declared rename FIRST, and `allow.dropColumn` named as what deletes
   *   the data — instead of offering only the permission that loses it.
   */
  constructor(blocked: Change[], changes: readonly Change[] = blocked) {
    const renames = suggestColumnRenames(changes);
    const hints = blocked.map((c) => {
      if (c.kind === "drop-column") {
        const rename = renameFor(renames, c);
        if (rename !== undefined) return renameHint(c, rename);
      }
      const option = allowOptionFor(c);
      const flag = option === undefined ? "(no flag enables this)" : `allow.${option}`;
      return `${c.kind} on ${changeLocator(c)}: pass ${flag}`;
    });
    const msg = `${blocked.length} blocked change(s):\n  - ${hints.join("\n  - ")}`;
    super(msg);
    this.blocked = blocked;
    this.enableHints = hints;
  }
}

/**
 * #258 — a table whose live PRIMARY KEY differs from the metadata identity cannot be
 * migrated: the diff/emit has no primary-key change kind, so the difference degrades
 * silently into an add-column + drop-column (the old PK column is dropped, the new one
 * is never made PK), leaving the table with no primary key and breaking every foreign
 * key that references it at apply time. Migration generation detects the move and throws
 * this instead of emitting un-appliable SQL (detect-and-refuse; the #226→#241 arc for D1
 * FK cascades is the precedent). A pure column RENAME is NOT a key move — the engine
 * preserves the PK through a `RENAME COLUMN` — and does not trigger this.
 */
export class PrimaryKeyChangeError extends Error {
  override readonly name = "PrimaryKeyChangeError";
  readonly table: string;
  readonly livePrimaryKey: string[];
  readonly expectedPrimaryKey: string[];
  readonly schema?: string;

  constructor(table: string, livePrimaryKey: string[], expectedPrimaryKey: string[], schema?: string) {
    const qualified = schema !== undefined ? `${schema}.${table}` : table;
    const fmt = (cols: string[]) => (cols.length > 0 ? `PRIMARY KEY (${cols.join(", ")})` : "no primary key");
    super(
      `primary key of "${qualified}" differs from the live database: live ${fmt(livePrimaryKey)} vs ` +
        `metadata ${fmt(expectedPrimaryKey)}. migrate cannot express a primary-key change (there is no ` +
        `add/drop-primary-key change kind), so this would silently drop the constraint and break every ` +
        `foreign key that references this table. Align the primary key manually — or reconcile the metadata ` +
        `identity to match the live table — before migrating.`,
    );
    this.table = table;
    this.livePrimaryKey = livePrimaryKey;
    this.expectedPrimaryKey = expectedPrimaryKey;
    if (schema !== undefined) this.schema = schema;
  }
}

// ---------------------------------------------------------------------------
// DeclaredRenameError — a --rename-table / --rename-column that does not apply
// ---------------------------------------------------------------------------

/**
 * Thrown by `diff()` when a declared rename (see `DeclaredRename`) cannot be resolved: the
 * old name is not in the database, the new name is not in the metadata, the rename was
 * already applied, or the renamed column also changes shape. Refusing is the point — a
 * declared rename that silently did nothing would fall back to drop+add and lose the data
 * the author declared it to keep.
 */
export class DeclaredRenameError extends Error {
  override readonly name = "DeclaredRenameError";
}

// ---------------------------------------------------------------------------
// DuplicateSqlNameError — two declarations generate one database name
// ---------------------------------------------------------------------------

/** One database name claimed by more than one declaration. */
export interface SqlNameCollision {
  /** The colliding database name (unqualified). */
  name: string;
  /** Each declaration that generates it, labelled for a human. */
  owners: string[];
  /** At least one owner is an index — the fix is a different rename. */
  involvesIndex: boolean;
}

/**
 * Thrown while building the expected schema when distinct declarations generate the same
 * database name: the DB would reject the second CREATE, so no migration is emitted.
 *
 * Index names are NOT prefixed with their table. An `identity.secondary` / `index.lookup`
 * name is the index's database name verbatim, and a database name is global — per
 * database on SQLite, per schema on Postgres (where indexes share `pg_class` with tables
 * and views). So two entities each declaring `byEmail` collide although each reads fine
 * on its own. The derived names are deliberately left as they are (changing them would
 * propose an index rename to every adopter); the fix is to rename one declaration.
 */
export class DuplicateSqlNameError extends Error {
  override readonly name = "DuplicateSqlNameError";
  readonly collisions: readonly SqlNameCollision[];

  constructor(collisions: readonly SqlNameCollision[]) {
    const lines = collisions.map((c) =>
      `  ${c.involvesIndex ? "index name" : "name"} "${c.name}" is generated by ${c.owners.join(" AND ")}`);
    const anyIndex = collisions.some((c) => c.involvesIndex);
    const anyOther = collisions.some((c) => !c.involvesIndex);
    const fixes: string[] = [];
    if (anyIndex) {
      fixes.push(
        "An index's database name is its identity.secondary / index.lookup name, used verbatim — it is " +
          "NOT prefixed with its table, and it must be unique across the database (SQLite) or schema " +
          "(Postgres), tables and views included. Rename one of the declarations to a table-scoped name " +
          "(e.g. `ownersByEmail`).",
      );
    }
    if (anyOther) {
      fixes.push("Rename one of the tables/views (entity source `@table`, projection `@kind view @view`).");
    }
    super(
      `ERR_DUPLICATE_SQL_NAME: distinct metadata declarations generate the same database name.\n` +
        `${lines.join("\n")}\n${fixes.join("\n")}`,
    );
    this.collisions = collisions;
  }
}

// ---------------------------------------------------------------------------
// Guards for the refusal errors above — exported so a CLI that CATCHES them
// matches by name beside the class that sets the name, never by `instanceof`
// or by a re-implemented string check of its own. Two physical copies of
// `@metaobjectsdev/migrate-ts` in one process (a global `meta` beside a
// project-local dependency) give the class and the instance different
// identities, so `instanceof` alone returns false for a real error and a
// refusal degrades into an unhandled throw — the same class-identity defect
// that split ts-poet's `Code` objects in 0.21.6, and the reason `metadata`
// exports node guards. A rename of a `name` field above breaks the matching
// guard here, in the same file, not silently three files away.
// ---------------------------------------------------------------------------

/** Is `err` the {@link BlockedChangesError} from a gated change in an emitted plan? */
export function isBlockedChangesError(err: unknown): err is BlockedChangesError {
  return err instanceof Error && err.name === "BlockedChangesError";
}

/** Is `err` the {@link PrimaryKeyChangeError} from a refused primary-key move? */
export function isPrimaryKeyChangeError(err: unknown): err is PrimaryKeyChangeError {
  return err instanceof Error && err.name === "PrimaryKeyChangeError";
}

/** Is `err` the {@link DuplicateSqlNameError} from two declarations sharing a database name? */
export function isDuplicateSqlNameError(err: unknown): err is DuplicateSqlNameError {
  return err instanceof Error && err.name === "DuplicateSqlNameError";
}

/** `migrate.conventions` names a schema-conventions preset that does not exist. */
export class UnknownSchemaConventionsError extends Error {
  override readonly name = "UnknownSchemaConventionsError";
  constructor(readonly selected: string, readonly presets: readonly string[]) {
    super(`migrate.conventions "${selected}" is not a schema-conventions preset: expected one of ${presets.join(", ")}`);
  }
}

/** A project-supplied schema-conventions object lacks members this version calls. */
export class InvalidSchemaConventionsError extends Error {
  override readonly name = "InvalidSchemaConventionsError";
  constructor(readonly id: string, readonly missing: readonly string[]) {
    super(`the schema conventions "${id}" are missing ${missing.join(", ")} — start from a preset ` +
      `({ ...efcoreConventions, id: "${id}", … }) so every member this version calls is present`);
  }
}

/** Is `err` the {@link UnknownSchemaConventionsError}? */
export function isUnknownSchemaConventionsError(err: unknown): err is UnknownSchemaConventionsError | InvalidSchemaConventionsError {
  // Both are a project's conventions selection the tool cannot use: a config error.
  return err instanceof Error && (err.name === "UnknownSchemaConventionsError" || err.name === "InvalidSchemaConventionsError");
}

/** Is `err` the {@link FkTargetNotUniqueError} from FKs whose targets are not unique keys? */
export function isFkTargetNotUniqueError(err: unknown): err is FkTargetNotUniqueError {
  return err instanceof Error && err.name === "FkTargetNotUniqueError";
}

/** Is `err` the {@link DeclaredRenameError} from a declared rename that does not apply? */
export function isDeclaredRenameError(err: unknown): err is DeclaredRenameError {
  return err instanceof Error && err.name === "DeclaredRenameError";
}
