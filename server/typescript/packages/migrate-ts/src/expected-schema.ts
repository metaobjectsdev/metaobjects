import type { ColumnNamingStrategy, MetaData, MetaField, MetaObject, MetaRoot, MetaValidator } from "@metaobjectsdev/metadata";
import {
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_COMPARISON, VALIDATOR_SUBTYPE_REQUIRED_WHEN,
  VALIDATOR_SUBTYPE_PRESENT_IFF, VALIDATOR_SUBTYPE_AT_LEAST_ONE,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_LEFT, VALIDATOR_ATTR_OP, VALIDATOR_ATTR_RIGHT,
  VALIDATOR_ATTR_FIELD, VALIDATOR_ATTR_WHEN, VALIDATOR_ATTR_EQUALS, VALIDATOR_ATTR_FIELDS,
  TYPE_OBJECT,
  TYPE_FIELD,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
  isWritableSource,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_ORDERS,
  IDENTITY_ATTR_WHERE,
  IDENTITY_ATTR_EXPR,
  IDENTITY_ATTR_USING,
  IDENTITY_ATTR_CONSTRAINT_NAME,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_AUTO_SET,
  AUTO_SET_ON_CREATE,
  AUTO_SET_ON_UPDATE,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_UNIQUE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_INT_VALUE_MAP,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_UUID,
  DB_COLUMN_TYPE_JSONB,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_ATTR_LENIENT,
  STORAGE_FLATTENED,
  DOC_ATTR_DESCRIPTION,
  applyColumnNamingStrategy, DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveTableName, resolveColumnName, resolveTableSchema,
} from "@metaobjectsdev/metadata";
import type { SqlType } from "./sql-type.js";
import type {
  Dialect, SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  CheckDescriptor, ViewDescriptor,
} from "./types.js";
import { qualifiedDbName } from "./qualified-name.js";
import { viewFingerprint } from "./view-fingerprint.js";
import { resolveViewColumns, type ExpectedViewColumnInput } from "./view-column-types.js";
import {
  resolveReferentialActions,
  validateSetNullNullability,
  readIdentityFields,
  findField,
  isRequired,
} from "./referential-actions.js";

export interface BuildExpectedSchemaOptions {
  /**
   * If set, normalize column SqlTypes for the target dialect so the diff
   * matches what introspection will see. For sqlite (and d1, which is SQLite
   * at the SQL level) this collapses boolean → integer{64} and
   * timestamp/date/time → text, since sqlite has no native boolean/timestamp
   * affinity and Drizzle's `integer(..., {mode:"boolean"})` / `text("ts")`
   * patterns produce INTEGER / TEXT in the actual DB.
   */
  dialect?: Dialect;
  /**
   * Column-naming strategy for fields with no `@column` override. Defaults to
   * `"snake_case"`. Must match the runtime's `ObjectManager` strategy — a
   * mismatch yields a schema whose columns the runtime can't address.
   */
  columnNamingStrategy?: ColumnNamingStrategy;
  /**
   * Expected views (projection → CREATE VIEW body), computed by the caller via
   * codegen-ts's `buildProjectionViews` and threaded in. migrate-ts does NOT
   * generate view DDL itself (it stays dependency-pure — never importing the
   * code generator); view SQL has a single source, `emitViewDdl` in codegen-ts.
   * Defaults to none.
   *
   * The caller supplies each view's output columns PHYSICALLY but untyped
   * (codegen-ts knows nothing of SqlType); Pass 4 resolves them against the
   * expected tables and computes the view's fingerprint.
   */
  views?: readonly ExpectedViewInput[];
}

/**
 * A view as the caller (codegen-ts `buildProjectionViews`) produces it — structurally
 * an `ExpectedView`. It becomes a full `ViewDescriptor` in Pass 4, which is where the
 * fingerprint is computed and the column types are resolved.
 */
export interface ExpectedViewInput {
  name: string;
  schema?: string;
  sql?: string;
  dependsOn?: readonly string[];
  columns?: readonly ExpectedViewColumnInput[];
  /**
   * `resolutionKey()` of the object that declared this view — its PROVENANCE.
   * Recorded in the provenance map and deliberately NEVER copied onto the
   * `ViewDescriptor`: descriptors are serialized into the committed snapshot, and
   * a descriptor that gains a field owes a `SNAPSHOT_FORMAT_VERSION` bump, which
   * hard-fails every older reader. Optional — a caller that supplies no FQN gets a
   * view with no provenance, which `scopeExpectedSchema` keeps (never guesses).
   */
  fqn?: string;
}

/**
 * Qualified physical name (`qualifiedDbName`) → the `resolutionKey()` of the
 * metadata object that declared it. The ONLY sound basis for a per-command scope
 * decision: a SQL name cannot be reversed into an FQN (naming strategies, `@table`
 * overrides and TPH folding are all lossy), and a second metadata walk would have
 * to re-implement Pass 1's skip rules — abstract, TPH subtype, no writable source,
 * `@unmanaged` — and would drift from them.
 */
export type SchemaProvenance = ReadonlyMap<string, string>;

export interface ExpectedSchemaWithProvenance {
  snapshot: SchemaSnapshot;
  provenance: SchemaProvenance;
}

/**
 * The expected schema as every existing caller wants it. Thin wrapper over
 * {@link buildExpectedSchemaWithProvenance}; byte-identical output.
 */
export function buildExpectedSchema(
  root: MetaData,
  opts?: BuildExpectedSchemaOptions,
): SchemaSnapshot {
  return buildExpectedSchemaWithProvenance(root, opts).snapshot;
}

/**
 * The expected schema PLUS the declaring FQN of every table and view in it.
 *
 * Provenance is threaded out of the passes that already hold the declaring node —
 * Pass 2 has each table's entity, Pass 4 each view's input — so there is exactly
 * one walk and one set of skip rules. Callers that filter by scope
 * (`scopeExpectedSchema`) consume it; callers that don't use the wrapper above.
 */
export function buildExpectedSchemaWithProvenance(
  root: MetaData,
  opts?: BuildExpectedSchemaOptions,
): ExpectedSchemaWithProvenance {
  // D1 is SQLite at the SQL level; normalize it so downstream dialect checks
  // don't need to handle "d1" separately.
  const dialect = opts?.dialect === "d1" ? "sqlite" : opts?.dialect;
  const strategy: ColumnNamingStrategy = opts?.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY;

  // Pass 1: collect entities + their resolved table names.
  // Skip:
  //   - abstract objects (e.g., BaseEntity)
  //   - TPH subtypes (their columns fold into the discriminator base's table)
  //   - any object with no declared/inherited WRITABLE source (#248 — covers
  //     value objects, projections, sourceless entities, and any sourceless
  //     custom subtype uniformly; see the rule comment below)
  const entities: { entity: MetaObject; tableName: string }[] = [];
  // #208 §7 — entities whose physical name must still resolve for FK TARGETING even
  // though we emit NO TableDescriptor for them: an @unmanaged table (Flyway/hand-
  // migration owns its DDL). An FK from a managed table INTO a Flyway-owned table is
  // legal and needs the target's physical name; only the table's own create/alter/drop
  // is suppressed (migration ORDERING vs the external tool is a documented adopter caveat).
  const fkTargetOnly: { entity: MetaObject; tableName: string }[] = [];
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  for (const child of root.children()) {
    if (child.type !== TYPE_OBJECT) continue;
    if (child.isAbstract) continue;
    // FR-017 TPH: a subtype shares its discriminator base's single table, so it
    // emits no table of its own. Its own columns are folded into the base below.
    if (isTphSubtype(child)) continue;
    // #248 — persistability derives from source presence, never subtype (loader
    // contract: zero sources ⇒ not persisted — metadata validate-source-roles).
    // Table iff a WRITABLE source is declared or inherited (ADR-0039 resolving).
    // Subsumes the old `subType === "value"` skip (value purity bans sources on
    // the resolving view) and the read-only-only projection skip (view pipeline
    // owns those); closes the fail-open where a sourceless object (custom
    // subtype or plain entity) got a phantom CREATE TABLE + fabricated FK name.
    // isWritableSource, not `instanceof MetaSource`: a second physical copy of
    // @metaobjectsdev/metadata would make the class check false for a real source
    // and silently drop this entity's table from the expected schema.
    const hasWritableSource = child.children().some(isWritableSource);
    if (!hasWritableSource) continue;
    const tableName = resolveTableName(child);
    // #208 §7 — an @unmanaged writable (table) source: emit no descriptor, but keep the
    // entity in entityToTable so an inbound FK resolves the physical name. OWN-source
    // detection (not resolving) to match collectUnmanagedNames, so the skip here and the
    // act-side drop-suppression there agree exactly — no split-brain where a table is not
    // created yet is still proposed for drop.
    const writableSource = child.ownChildren().find(isWritableSource);
    if (writableSource?.isUnmanaged) {
      fkTargetOnly.push({ entity: child as MetaObject, tableName });
      continue;
    }
    entities.push({ entity: child as MetaObject, tableName });
  }
  // FK targets resolve by FULLY-QUALIFIED name, not bare name. The loader qualifies a
  // reference's targetEntity to its canonical FQN (e.g. "acme::a::Foo"), and each entity's
  // `resolutionKey()` is that same "<package>::<name>" form — so an FK target binds the
  // EXACT entity in the EXACT package. Keying by bare name (the prior behavior) silently
  // mis-resolved when two packages declared a same-named entity: the last one loaded won
  // the map, so a cross-package FK could point at the wrong table.
  const AMBIGUOUS = Symbol("ambiguous-bare-name");
  const byFqn = new Map<string, string>();
  const byBare = new Map<string, string | typeof AMBIGUOUS>();
  for (const e of [...entities, ...fkTargetOnly]) {
    byFqn.set(e.entity.resolutionKey(), e.tableName);
    const bare = e.entity.name;
    byBare.set(bare, byBare.has(bare) ? AMBIGUOUS : e.tableName);
  }
  // Resolve an FK target to its physical table, mirroring the metadata package's
  // `resolutionKey()` contract so migrate binds the SAME entity the loader/codegen would.
  // A reference's `targetEntity` is the raw `@references` value (usually BARE), so a bare
  // ref is qualified with the REFERRER's package first (`<referrerPkg>::<ref>`), then the
  // root-level (empty-package) object, then an UNAMBIGUOUS bare name. Keying by bare name
  // alone (the prior behavior) let the last-loaded of two same-named entities win the map,
  // so a cross-package FK could silently point at the wrong table.
  const resolveTargetTable = (targetRef: string, referrerKey: string): string | undefined => {
    const direct = byFqn.get(targetRef);
    if (direct !== undefined) return direct;
    if (!targetRef.includes("::")) {
      const sep = referrerKey.lastIndexOf("::");
      if (sep >= 0) {
        const pkgLocal = byFqn.get(`${referrerKey.slice(0, sep)}::${targetRef}`);
        if (pkgLocal !== undefined) return pkgLocal;
      }
      const rootLevel = byFqn.get(`::${targetRef}`);
      if (rootLevel !== undefined) return rootLevel;
    }
    const bare = targetRef.includes("::") ? targetRef.slice(targetRef.lastIndexOf("::") + 2) : targetRef;
    const byBareHit = byBare.get(bare);
    return byBareHit === AMBIGUOUS ? undefined : byBareHit;
  };

  // Provenance: qualified physical name → declaring object's FQN. Recorded as the
  // descriptors are built, never re-derived from a SQL name (lossy) and never by a
  // second walk (it would have to duplicate Pass 1's skip rules and would drift from
  // them — a TPH subtype, for one, shares its base's table and declares none of its own).
  const provenance = new Map<string, string>();

  // Pass 2: build full descriptors with FK resolution.
  // Schema is resolved here (not stored in Pass 1) to avoid exactOptionalPropertyTypes
  // issues with `string | undefined` vs `schema?: string`.
  const tables: TableDescriptor[] = entities.map(({ entity, tableName }) => {
    const t = buildTable(entity, tableName, resolveTargetTable, root as MetaRoot, strategy, dialect);
    const schema = resolveTableSchema(entity);
    if (schema !== undefined) t.schema = schema;
    provenance.set(qualifiedDbName(t), entity.resolutionKey());
    return t;
  });

  // Pass 3: dialect-specific SqlType normalization.
  if (dialect === "sqlite") {
    for (const table of tables) {
      for (const col of table.columns) {
        const kindBefore = col.sqlType.kind;
        col.sqlType = normalizeForSqlite(col.sqlType);
        // The default VALUE must be normalized alongside the TYPE, or the three layers
        // disagree. A boolean column becomes an integer column here, so its canonical
        // "true"/"false" literal must become "1"/"0" too:
        //   - leave it as "false" → the emitter sees an integer column with a
        //     non-numeric literal and quotes it (`DEFAULT 'false'`), which SQLite
        //     stores as TEXT in a numeric-affinity column, so `WHERE col = 0` silently
        //     matches nothing;
        //   - emit `0` while the expected side still says "false" → introspection reads
        //     back "0", `columnDefaultsEqual` is a strict string compare, and the diff
        //     reports `change-column-default` forever — which on SQLite means a
        //     destructive recreate-and-copy of the whole table on EVERY migrate.
        // Normalizing here keeps expected == emitted == introspected.
        if (kindBefore === "boolean" && col.default?.kind === "literal") {
          const normalized = normalizeBooleanLiteralForSqlite(col.default.value);
          if (normalized !== undefined) col.default = { kind: "literal", value: normalized };
        }
        // `now()` is Postgres-only; SQLite has no such function, so a
        // `DEFAULT now()` (the @autoSet insert-time default, and any authored
        // @default "now()") makes the emitted CREATE TABLE un-appliable
        // (`near "(": syntax error`). Normalize to the SQL-standard
        // CURRENT_TIMESTAMP *here* — not at emit time — so all three layers
        // agree: emit renders `DEFAULT CURRENT_TIMESTAMP`, sqlite stores that
        // token verbatim, and introspection reads back the identical expr,
        // keeping the re-diff empty (an emit-only mapping would report
        // change-column-default forever → recreate-and-copy on every run).
        if (col.default?.kind === "expr" && /^now\(\)$/i.test(col.default.value.trim())) {
          col.default = { kind: "expr", value: "CURRENT_TIMESTAMP" };
        }
      }
      // `@using` names a Postgres index access method (gin/gist/hash/…).
      // SQLite has exactly ONE access method (b-tree) and no USING clause, so
      // the attr is physically meaningless there: the emitter cannot render it
      // and introspection can never read it back. Strip it from the expected
      // snapshot — the closest physical realization is a plain index — so the
      // diff converges instead of proposing drop/add on every run.
      for (const index of table.indexes) {
        delete index.using;
      }
    }
  }

  // Dialect validation: SQLite has no schema concept; reject any non-default @schema.
  if (dialect === "sqlite") {
    for (const table of tables) {
      if (table.schema !== undefined) {
        throw new Error(
          `sqlite does not support DB schemas; entity-table "${table.name}" declares @schema "${table.schema}"`,
        );
      }
    }
  }

  // Pass 4: views from read-only projections — supplied by the caller (computed
  // via codegen-ts's buildProjectionViews, the single view-SQL source). migrate-ts
  // never generates view DDL itself, keeping it free of a codegen-ts dependency.
  //
  // Two things are derived here rather than by the caller:
  //   - the FINGERPRINT, a hash of the generated body. It is the only sound way to
  //     compare a view against Postgres, which deparses view SQL and so can never
  //     hand back the text we wrote (see view-fingerprint.ts). Computed here so the
  //     producer and the parser of the marker live in one package.
  //   - the column SQL TYPES, resolved against the tables built above. They decide
  //     whether a view change can use a non-destructive CREATE OR REPLACE.
  const views: ViewDescriptor[] = (opts?.views ?? []).map((v) => {
    const columns = resolveViewColumns(v.columns, tables);
    const descriptor: ViewDescriptor = {
      name: v.name,
      ...(v.schema !== undefined ? { schema: v.schema } : {}),
      ...(v.sql !== undefined ? { sql: v.sql, fingerprint: viewFingerprint(v.sql) } : {}),
      ...(v.dependsOn !== undefined ? { dependsOn: v.dependsOn } : {}),
      ...(columns !== undefined ? { columns } : {}),
    };
    // The declaring FQN goes to the provenance map ONLY — never onto the descriptor,
    // which is what the committed snapshot serializes (see ExpectedViewInput.fqn).
    if (v.fqn !== undefined) provenance.set(qualifiedDbName(descriptor), v.fqn);
    return descriptor;
  });

  // Collision guard: two DISTINCT metadata objects that resolve to the same generated
  // database name (schema-qualified) produce un-appliable DDL — the DB rejects the second
  // CREATE, or a diff silently conflates the two. Catch it at build time with both owners
  // named, rather than shipping a broken migration. Covers table/table, view/view, and
  // table/view collisions across packages.
  const sqlNameOwners = new Map<string, string[]>();
  const addOwner = (schema: string | undefined, name: string, label: string): void => {
    const key = `${schema ?? ""}.${name}`;
    const list = sqlNameOwners.get(key);
    if (list) list.push(label);
    else sqlNameOwners.set(key, [label]);
  };
  for (const { entity, tableName } of entities) {
    addOwner(resolveTableSchema(entity), tableName, `table ${entity.resolutionKey()}`);
  }
  for (const v of views) addOwner(v.schema, v.name, `view "${v.name}"`);
  const collisions = [...sqlNameOwners.entries()].filter(([, owners]) => owners.length > 1);
  if (collisions.length > 0) {
    const detail = collisions
      .map(([key, owners]) => `  "${key.slice(key.indexOf(".") + 1)}" ← ${owners.join(" + ")}`)
      .join("\n");
    throw new Error(
      `ERR_DUPLICATE_SQL_NAME: distinct metadata objects generate the same database name. ` +
        `Rename one (entity source \`@table\`, projection \`@kind view @table\`):\n${detail}`,
    );
  }

  return { snapshot: { tables, views }, provenance };
}

/**
 * Normalize a canonical SqlType for what sqlite introspection will actually see.
 * sqlite stores all integers (including booleans) as INTEGER, and uses TEXT for
 * date/time/timestamp affinities by default.
 */
/**
 * SQLite has no boolean literal: the canonical "true"/"false" become 1/0 so the value
 * matches the integer column the type is normalized to. Returns undefined for anything
 * unrecognized (the loader validates coercibility long before here) so we never silently
 * rewrite a value we don't understand.
 */
function normalizeBooleanLiteralForSqlite(value: string): string | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return "1";
    case "false":
    case "0":
      return "0";
    default:
      return undefined;
  }
}

function normalizeForSqlite(sqlType: SqlType): SqlType {
  switch (sqlType.kind) {
    case "boolean":
      return { kind: "integer", bits: 64 };
    case "timestamp":
    case "date":
    case "time":
      return { kind: "text" };
    case "integer":
      // SQLite stores every INTEGER as a 64-bit value and Drizzle's int() emits
      // plain "INTEGER" regardless of source bit-width. Collapse 32 → 64 so the
      // expected snapshot matches what introspection sees.
      return { kind: "integer", bits: 64 };
    case "real4":
      // SQLite has a single float storage class ("REAL"); it cannot distinguish
      // single-precision (real4 / field.float) from double-precision (real /
      // field.double). Collapse real4 → real so the expected snapshot matches
      // what the SQLite introspector produces, preventing a phantom
      // change-column-type diff on every field.float column.
      return { kind: "real" };
    case "uuid":
      // SQLite has no native uuid type; uuid values are stored as TEXT (the
      // conformance corpus is Postgres-only, but TS supports a sqlite dialect).
      // Collapse uuid → text so the expected snapshot matches what the SQLite
      // introspector produces, preventing a phantom change-column-type diff.
      return { kind: "text" };
    case "array":
      // SQLite has no array type; the sqlite emit stores arrays as TEXT (JSON),
      // so the expected snapshot collapses array → text to match introspection.
      return { kind: "text" };
    default:
      return sqlType;
  }
}

// ---------------------------------------------------------------------------
// FR-017 TPH (table-per-hierarchy) — single-table schema emission.
// ---------------------------------------------------------------------------

/** The @discriminator-bearing ancestor of `entity`, or undefined for non-TPH. */
function discriminatorBaseOf(entity: MetaData): MetaData | undefined {
  let a = entity.superResolved;
  while (a !== undefined) {
    // ADR-0039 category 3: super-resolution walk — read each ancestor's OWN
    // @discriminator as we ascend (this manual walk IS the resolution).
    if (a.ownAttr(OBJECT_ATTR_DISCRIMINATOR) !== undefined) return a;
    a = a.superResolved;
  }
  return undefined;
}

/** True if `entity` is a TPH SUBTYPE (declares @discriminatorValue + has a
 *  discriminator-bearing ancestor). Such an entity emits no table of its own. */
function isTphSubtype(entity: MetaData): boolean {
  return (
    // ADR-0039: effective attr — @discriminatorValue may be inherited (sub-subtype).
    entity.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE) !== undefined &&
    discriminatorBaseOf(entity) !== undefined
  );
}

/** Concrete TPH subtypes whose discriminator base is `base` (root-level scan). */
function tphConcreteSubtypes(base: MetaObject, root: MetaData): MetaObject[] {
  // ADR-0039: effective attr — @discriminator may be inherited.
  if (base.attr(OBJECT_ATTR_DISCRIMINATOR) === undefined) return [];
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  return root.children().filter(
    (c): c is MetaObject =>
      c.type === TYPE_OBJECT &&
      !c.isAbstract &&
      // ADR-0039: effective attr — @discriminatorValue may be inherited (sub-subtype).
      c.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE) !== undefined &&
      discriminatorBaseOf(c) === base,
  );
}

function buildTable(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (targetRef: string, referrerKey: string) => string | undefined,
  root: MetaRoot,
  strategy: ColumnNamingStrategy,
  dialect: Dialect | undefined,
): TableDescriptor {
  // Use effective accessors so inherited fields/identities (from `extends:` /
  // abstract bases like BaseEntity) are included.
  const pkIdentity = entity.primaryIdentity();

  const pkJsNames = pkIdentity ? readIdentityFields(pkIdentity) : [];
  const pkGeneration = pkIdentity
    // ADR-0039: effective attr — @generation may be inherited via the identity's extends.
    ? (pkIdentity.attr(IDENTITY_ATTR_GENERATION) as string | undefined)
    : undefined;

  const primaryKey = pkJsNames.map((jsName) => {
    const field = findField(entity, jsName);
    return field ? resolveColumnName(field, strategy) : applyColumnNamingStrategy(jsName, strategy);
  });

  const columns: ColumnDescriptor[] = [];
  for (const field of entity.fields()) {
    // #213 — a derived (origin-bearing) field is read-only and lives only on the
    // read (view) side (FR-024 §7 / ADR-0028); it is NOT a physical column on the
    // entity's write table. Excluding it here stops the leak that put a joined
    // passthrough onto the write table (and collided with a hand-written
    // `SELECT o.*, extra` view's alias).
    if (field.isDerived()) continue;
    const isPk = pkJsNames.includes(field.name);
    if (
      field.subType === FIELD_SUBTYPE_OBJECT &&
      // ADR-0039: resolving — @storage may be inherited via extends.
      field.attr(FIELD_ATTR_STORAGE) === STORAGE_FLATTENED
    ) {
      // Flattened storage: expand nested value-object fields as prefixed columns.
      // The parent field.object itself does NOT produce its own column.
      columns.push(...flattenObjectField(field, root, strategy));
    } else {
      columns.push(buildColumn(field, isPk, isPk ? pkGeneration : undefined, strategy));
    }
  }

  // FR-017 TPH: if this is a discriminator base, fold each concrete subtype's
  // OWN fields into the single table as NULLABLE columns (a row of any other
  // subtype stores NULL there), even when the field is @required. Dedupe by
  // column name so an inherited/overridden base column is not re-emitted.
  // ADR-0039: effective attr — @discriminator may be inherited (deep TPH base).
  if (entity.attr(OBJECT_ATTR_DISCRIMINATOR) !== undefined) {
    const existing = new Set(columns.map((c) => c.name));
    for (const sub of tphConcreteSubtypes(entity, root)) {
      // ADR-0039 category 1: emit-declared-here — fold ONLY the subtype's OWN
      // fields (inherited base fields are already emitted on the base table).
      for (const field of sub.ownChildren()) {
        if (field.type !== TYPE_FIELD) continue;
        // #213 — a TPH subtype's derived field is read-only too; never a column.
        if ((field as MetaField).isDerived()) continue;
        const col = buildColumn(field, false, undefined, strategy);
        if (existing.has(col.name)) continue;
        col.nullable = true; // subtype-only columns are always nullable in TPH
        columns.push(col);
        existing.add(col.name);
      }
    }
  }

  const descriptor: TableDescriptor = {
    name: tableName,
    columns,
    indexes: buildSecondaryIndexes(entity, tableName, strategy),
    foreignKeys: buildForeignKeys(entity, tableName, resolveTargetTable, root, strategy),
    checks: buildChecks(entity, tableName, strategy, dialect),
    primaryKey,
  };
  const entityDesc = readDescription(entity);
  if (entityDesc !== undefined) descriptor.description = entityDesc;
  return descriptor;
}

/**
 * Read effective `description` attr from a node. Returns the string if present
 * and non-empty, undefined otherwise. Uses `.attr` (effective, not own) so a
 * node that extends an abstract base picks up the base's description — required
 * for both entity- and field-level COMMENT ON parity with the entity-attr contract.
 */
function readDescription(node: { attr: (n: string) => unknown }): string | undefined {
  const v = node.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function buildSecondaryIndexes(
  entity: MetaObject, tableName: string, strategy: ColumnNamingStrategy,
): IndexDescriptor[] {
  const indexes: IndexDescriptor[] = [];

  // (a) Implicit unique indexes from @unique fields. Drizzle auto-creates these
  // on the DB side using the convention `<table>_<column>_unique` whenever a
  // column has `.unique()`. We mirror them in the expected schema so the diff
  // doesn't see them as drop-only on the actual side.
  for (const field of entity.fields()) {
    // ADR-0039: resolving — @unique may be inherited via extends.
    if (field.attr(FIELD_ATTR_UNIQUE) !== true) continue;
    const colName = resolveColumnName(field, strategy);
    indexes.push({
      name: `${tableName}_${colName}_unique`,
      columns: [colName],
      unique: true,
    });
  }

  // (b) Explicit secondary identities — always unique (uniqueness is in the type).
  // The index carries the identity's own name, with no table prefix. This side is the
  // AUTHORITY: these names are already in live databases, so changing them would emit
  // DROP/CREATE INDEX churn against production. codegen was the side that disagreed —
  // it composed `idx_<table>_<col>...` — and this comment previously asserted that it
  // did not, which is how the divergence went unnoticed in both files at once. The two
  // are now compared by `codegen-ts`'s `secondary-index-name-parity.test.ts` rather than
  // by a claim in a comment.
  for (const identity of entity.secondaryIdentities()) {
    // ADR-0039: effective attrs — a secondary identity's attrs may be inherited via extends.
    const exprRaw = identity.attr(IDENTITY_ATTR_EXPR);
    const expr = typeof exprRaw === "string" && exprRaw.trim().length > 0 ? exprRaw.trim() : undefined;
    const fieldNames = readIdentityFields(identity);
    // An expression index keys off @expr (not @fields); a plain index needs @fields.
    if (fieldNames.length === 0 && expr === undefined) continue;
    const cols = fieldNames.map((jsName) => {
      const field = findField(entity, jsName);
      return field ? resolveColumnName(field, strategy) : applyColumnNamingStrategy(jsName, strategy);
    });
    const index: IndexDescriptor = {
      name: identity.name,
      columns: expr ? [] : cols,
      unique: true,
    };
    if (expr) index.expr = expr;
    const usingRaw = identity.attr(IDENTITY_ATTR_USING);
    if (typeof usingRaw === "string" && usingRaw.trim().length > 0 && usingRaw.trim() !== "btree") {
      index.using = usingRaw.trim();
    }
    // @orders — per-field sort direction (positional to @fields). Only attach when
    // at least one field is descending (an all-ascending array is the default and
    // must serialize identically to "no orders" for diff stability).
    const ordersRaw = identity.attr(IDENTITY_ATTR_ORDERS);
    if (Array.isArray(ordersRaw)) {
      const orders = cols.map((_, i) => (ordersRaw[i] === "desc" ? "desc" : "asc")) as (
        "asc" | "desc"
      )[];
      if (orders.some((o) => o === "desc")) index.orders = orders;
    }
    // @where — partial-index predicate.
    const whereRaw = identity.attr(IDENTITY_ATTR_WHERE);
    if (typeof whereRaw === "string" && whereRaw.trim().length > 0) {
      index.where = whereRaw.trim();
    }
    indexes.push(index);
  }

  // (c) index.lookup — always non-unique. Physical attrs @orders/@using/@where/@expr share
  // the same constant names as identity.secondary (both registered by the db provider).
  for (const lookup of entity.lookupIndexes()) {
    const exprRaw = lookup.attr(IDENTITY_ATTR_EXPR);
    const expr = typeof exprRaw === "string" && exprRaw.trim().length > 0 ? exprRaw.trim() : undefined;
    const fieldNames = lookup.fields(); // ADR-0039: resolving via MetaIndex.fields()
    // An expression index keys off @expr (not @fields); a plain index needs @fields.
    if (fieldNames.length === 0 && expr === undefined) continue;
    const cols = fieldNames.map((jsName) => {
      const field = findField(entity, jsName);
      return field ? resolveColumnName(field, strategy) : applyColumnNamingStrategy(jsName, strategy);
    });
    const index: IndexDescriptor = {
      name: lookup.name,
      columns: expr ? [] : cols,
      unique: false,
    };
    if (expr) index.expr = expr;
    const usingRaw = lookup.attr(IDENTITY_ATTR_USING);
    if (typeof usingRaw === "string" && usingRaw.trim().length > 0 && usingRaw.trim() !== "btree") {
      index.using = usingRaw.trim();
    }
    const ordersRaw = lookup.attr(IDENTITY_ATTR_ORDERS);
    if (Array.isArray(ordersRaw)) {
      const orders = cols.map((_, i) => (ordersRaw[i] === "desc" ? "desc" : "asc")) as (
        "asc" | "desc"
      )[];
      if (orders.some((o) => o === "desc")) index.orders = orders;
    }
    const whereRaw = lookup.attr(IDENTITY_ATTR_WHERE);
    if (typeof whereRaw === "string" && whereRaw.trim().length > 0) {
      index.where = whereRaw.trim();
    }
    indexes.push(index);
  }

  return indexes;
}

/**
 * Derive a CHECK constraint per `field.enum` field: `CHECK (<col> IN ('A', 'B'))`,
 * constraining the column to the declared `@values` members. The constraint name
 * is `<table>_<column>_chk`, mirroring the FK/index naming conventions.
 *
 * `@values` is read effective (`field.attr`) so a concrete field that extends an
 * abstract `field.enum` super inherits its members. The loader rejects a
 * `field.enum` without `@values` (ERR_MISSING_REQUIRED_ATTR), so a present enum
 * field always yields a non-empty member set; a defensive guard skips any edge
 * case where the array is absent rather than emitting `IN ()`.
 */
/**
 * Map a single declared validator to a DB CHECK descriptor, or null when it has
 * no SQL-expressible form on this dialect. The constraint name is
 * `<table>_<col>_<validator>_chk`. The expression references the resolved physical
 * column name verbatim (matching the enum-check convention).
 */
function validatorCheck(
  v: MetaValidator, qcol: string, tableName: string, col: string, dialect: Dialect | undefined,
): CheckDescriptor | null {
  switch (v.subType) {
    case VALIDATOR_SUBTYPE_NUMERIC: {
      const parts: string[] = [];
      if (v.min !== undefined) parts.push(`${qcol} >= ${v.min}`);
      if (v.max !== undefined) parts.push(`${qcol} <= ${v.max}`);
      if (parts.length === 0) return null;
      return { name: `${tableName}_${col}_numeric_chk`, expression: parts.join(" AND ") };
    }
    case VALIDATOR_SUBTYPE_LENGTH: {
      const parts: string[] = [];
      if (v.min !== undefined) parts.push(`length(${qcol}) >= ${v.min}`);
      if (v.max !== undefined) parts.push(`length(${qcol}) <= ${v.max}`);
      if (parts.length === 0) return null;
      return { name: `${tableName}_${col}_length_chk`, expression: parts.join(" AND ") };
    }
    case VALIDATOR_SUBTYPE_REGEX: {
      // Postgres-only: SQLite has no native regex operator.
      if (dialect === "sqlite" || dialect === "d1") return null;
      // ADR-0039: effective attr — @pattern may be inherited via the validator's extends.
      const pattern = v.attr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      return {
        name: `${tableName}_${col}_regex_chk`,
        expression: `${qcol} ~ '${pattern.replace(/'/g, "''")}'`,
      };
    }
    default:
      return null;
  }
}

/**
 * Quote a column identifier for embedding in a CHECK expression. Both Postgres
 * and SQLite quote identifiers with double-quotes, so the dialect-neutral
 * expression text can carry a quoted column. Quoting is REQUIRED for a
 * mixed-case column (e.g. `enumVal`): a bare `enumVal IN (...)` folds to
 * lowercase `enumval` and references a non-existent column. The check-expression
 * comparator (`normalizeCheckExpr`) strips quotes so an introspected check still
 * compares equal.
 */
function quoteCheckCol(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

function buildChecks(
  entity: MetaObject, tableName: string, strategy: ColumnNamingStrategy, dialect: Dialect | undefined,
): CheckDescriptor[] {
  const checks: CheckDescriptor[] = [];
  for (const field of entity.fields()) {
    // No field-level CHECKs on array columns: the derived expressions assume a
    // SCALAR column. `"labels" IN ('A','B')` against a text[] is a type error at
    // CREATE TABLE; `length(col)`/range checks are equally scalar-shaped. Array
    // element validation (enum membership, ranges) is enforced app-side (Zod /
    // per-port validators), matching codegen-ts's column-mapper which also skips
    // the enum literal-union for isArray columns.
    // ADR-0039: resolving — array-ness may be inherited via extends.
    if (field.resolvedIsArray()) continue;
    const col = resolveColumnName(field, strategy);
    const qcol = quoteCheckCol(col);
    // Enum membership check. An INT-BACKED enum (@intValueMap, design D5) stores
    // the mapped integers, so the CHECK lists those integers unquoted rather than
    // the member strings — `IN (0, 5, 9)`, not `IN ('DRAFT', …)`. The members are
    // still the SSOT: the integers are read THROUGH the map, keyed by member, so a
    // member with no mapping cannot silently vanish from the constraint.
    if (field.subType === FIELD_SUBTYPE_ENUM) {
      const raw = field.attr(FIELD_ATTR_VALUES);
      if (Array.isArray(raw) && raw.length > 0) {
        const values = raw.map((v) => String(v));
        const intMap = intValueMapOf(field);
        let expression: string;
        if (intMap !== undefined) {
          // The loader pins key-set-equals-@values (Check 5b) in every port, so every
          // member resolves. Guard anyway: emitting a partial IN list would silently
          // reject rows the model considers valid.
          const ints = values.map((v) => {
            const n = intMap[v];
            if (typeof n !== "number") {
              throw new Error(
                `field.enum '${field.name}' @intValueMap has no integer for member '${v}' — ` +
                  `cannot build the CHECK constraint for column '${col}'.`,
              );
            }
            return String(n);
          });
          expression = `${qcol} IN (${ints.join(", ")})`;
        } else {
          expression = `${qcol} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
        }
        checks.push({ name: `${tableName}_${col}_chk`, expression });
      }
    }
    // Validator-derived checks.
    for (const v of field.validators()) {
      const check = validatorCheck(v, qcol, tableName, col, dialect);
      if (check) checks.push(check);
    }
  }
  // Entity-scoped cross-field validators (comparison / requiredWhen / presentIff / atLeastOne).
  for (const v of entity.validators()) {
    const check = crossFieldCheck(v, entity, tableName, strategy, dialect);
    if (check) checks.push(check);
  }
  return checks;
}

const COMPARISON_SQL_OP: Record<string, string> = {
  gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>", eq: "=",
};

/** Resolve a by-name field reference to its physical column (quoted) + the MetaField, or null. */
function resolveRef(
  entity: MetaObject, name: unknown, strategy: ColumnNamingStrategy,
): { qcol: string; field: ReturnType<MetaObject["fields"]>[number] } | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const field = entity.fields().find((f) => f.name === name);
  if (!field) return null;
  return { qcol: quoteCheckCol(resolveColumnName(field, strategy)), field };
}

/**
 * Render an @equals gating value as a SQL literal, typed by the gating field's
 * subtype: boolean → TRUE/FALSE (1/0 on sqlite/d1), numeric → bare number,
 * everything else → quoted string.
 */
function renderEquals(
  raw: unknown, whenField: ReturnType<MetaObject["fields"]>[number], dialect: Dialect | undefined,
): string {
  const s = String(raw);
  if (whenField.subType === FIELD_SUBTYPE_BOOLEAN) {
    const truthy = s === "true" || s === "1" || s === "TRUE";
    if (dialect === "sqlite" || dialect === "d1") return truthy ? "1" : "0";
    return truthy ? "TRUE" : "FALSE";
  }
  const numeric = whenField.subType === FIELD_SUBTYPE_INT || whenField.subType === FIELD_SUBTYPE_LONG
    || whenField.subType === FIELD_SUBTYPE_DOUBLE || whenField.subType === FIELD_SUBTYPE_FLOAT
    || whenField.subType === FIELD_SUBTYPE_DECIMAL || whenField.subType === FIELD_SUBTYPE_CURRENCY;
  if (numeric && /^-?\d+(\.\d+)?$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Derive a CHECK from an entity-scoped cross-field validator. Every reference is
 * resolved to its physical column by name; nothing raw is read from metadata.
 * Returns null (skips the check) if any referenced field is missing.
 */
function crossFieldCheck(
  v: MetaValidator, entity: MetaObject, tableName: string,
  strategy: ColumnNamingStrategy, dialect: Dialect | undefined,
): CheckDescriptor | null {
  switch (v.subType) {
    case VALIDATOR_SUBTYPE_COMPARISON: {
      // ADR-0039: effective attrs — cross-field validator attrs may be inherited via extends.
      const left = resolveRef(entity, v.attr(VALIDATOR_ATTR_LEFT), strategy);
      const right = resolveRef(entity, v.attr(VALIDATOR_ATTR_RIGHT), strategy);
      const op = COMPARISON_SQL_OP[String(v.attr(VALIDATOR_ATTR_OP))];
      if (!left || !right || !op) return null;
      const lc = resolveColumnName(left.field, strategy);
      return { name: `${tableName}_${lc}_cmp_chk`, expression: `${left.qcol} ${op} ${right.qcol}` };
    }
    case VALIDATOR_SUBTYPE_REQUIRED_WHEN: {
      // ADR-0039: effective attrs — cross-field validator attrs may be inherited via extends.
      const target = resolveRef(entity, v.attr(VALIDATOR_ATTR_FIELD), strategy);
      const when = resolveRef(entity, v.attr(VALIDATOR_ATTR_WHEN), strategy);
      if (!target || !when) return null;
      const lit = renderEquals(v.attr(VALIDATOR_ATTR_EQUALS), when.field, dialect);
      const fc = resolveColumnName(target.field, strategy);
      return {
        name: `${tableName}_${fc}_reqwhen_chk`,
        expression: `(${when.qcol} IS DISTINCT FROM ${lit}) OR (${target.qcol} IS NOT NULL)`,
      };
    }
    case VALIDATOR_SUBTYPE_PRESENT_IFF: {
      // ADR-0039: effective attrs — cross-field validator attrs may be inherited via extends.
      const target = resolveRef(entity, v.attr(VALIDATOR_ATTR_FIELD), strategy);
      const when = resolveRef(entity, v.attr(VALIDATOR_ATTR_WHEN), strategy);
      if (!target || !when) return null;
      const lit = renderEquals(v.attr(VALIDATOR_ATTR_EQUALS), when.field, dialect);
      const fc = resolveColumnName(target.field, strategy);
      return {
        name: `${tableName}_${fc}_presentiff_chk`,
        expression: `(${target.qcol} IS NOT NULL) = (${when.qcol} IS NOT DISTINCT FROM ${lit})`,
      };
    }
    case VALIDATOR_SUBTYPE_AT_LEAST_ONE: {
      // ADR-0039: effective attr — @fields may be inherited via the validator's extends.
      const raw = v.attr(VALIDATOR_ATTR_FIELDS);
      const names = Array.isArray(raw) ? raw : (typeof raw === "string" ? [raw] : []);
      const refs = names.map((n) => resolveRef(entity, n, strategy));
      if (refs.length === 0 || refs.some((r) => r === null)) return null;
      const firstCol = resolveColumnName(refs[0]!.field, strategy);
      return {
        name: `${tableName}_${firstCol}_atleastone_chk`,
        expression: refs.map((r) => `${r!.qcol} IS NOT NULL`).join(" OR "),
      };
    }
    default:
      return null;
  }
}

function buildForeignKeys(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (targetRef: string, referrerKey: string) => string | undefined,
  root: MetaRoot,
  strategy: ColumnNamingStrategy,
): FkDescriptor[] {
  const fks: FkDescriptor[] = [];
  for (const refChild of entity.referenceIdentities()) {
    // @enforce: false → logical-only reference; not a physical FK constraint.
    if (!refChild.enforce) continue;
    const targetEntity = refChild.targetEntity;
    if (targetEntity === undefined) continue;
    const refTable = resolveTargetTable(targetEntity, entity.resolutionKey());
    if (!refTable) continue;

    const fkFieldJsNames = readIdentityFields(refChild);
    if (fkFieldJsNames.length === 0) continue;

    const fkCols = fkFieldJsNames.map((jsName) => {
      const fkField = findField(entity, jsName);
      return fkField ? resolveColumnName(fkField, strategy) : applyColumnNamingStrategy(jsName, strategy);
    });

    // Target columns: prefer explicit multi-field dotted form, else delegate
    // to MetaReferenceIdentity.resolvedTargetPkField (single field → target's
    // primary identity → "id" fallback). Each target FIELD name must resolve to
    // its PHYSICAL column via the target entity's own @column override (e.g. a
    // PK field `id` with `@column: "Id"`), exactly like fkCols above — the raw
    // naming strategy alone would emit the logical name and phantom-diff every
    // FK into that table (expected ["id"] vs actual ["Id"]).
    // targetEntity may be package-qualified (FQN); findObject is keyed by bare
    // name — same fallback as resolvedTargetPkField/resolveTargetTable.
    const targetObj = root.findObject(targetEntity)
      ?? (targetEntity.includes("::")
        ? root.findObject(targetEntity.slice(targetEntity.lastIndexOf("::") + 2))
        : undefined);
    const explicitTargetFields = refChild.targetFields;
    const targetFieldNames = explicitTargetFields.length > 1
      ? explicitTargetFields
      : [refChild.resolvedTargetPkField(root) ?? "id"];
    const refColumns = targetFieldNames.map((jsName) => {
      const targetField = targetObj ? findField(targetObj, jsName) : undefined;
      return targetField
        ? resolveColumnName(targetField, strategy)
        : applyColumnNamingStrategy(jsName, strategy);
    });

    const { onDelete, onUpdate } = resolveReferentialActions(entity, refChild);
    // An explicit @constraintName adopts an existing FK name (e.g. a database
    // created by another toolchain); absent → the auto-derived default.
    // ADR-0039: effective attr — @constraintName may be inherited via the identity's extends.
    const constraintNameOverride = refChild.attr(IDENTITY_ATTR_CONSTRAINT_NAME);
    const constraintName =
      typeof constraintNameOverride === "string" && constraintNameOverride.length > 0
        ? constraintNameOverride
        : `${tableName}_${fkCols[0]}_fk`;

    // Guard: ON DELETE SET NULL requires nullable FK columns.
    validateSetNullNullability(entity, refChild, onDelete, constraintName);

    const fk: FkDescriptor = {
      name: constraintName,
      columns: fkCols,
      refTable,
      refColumns,
    };
    if (onDelete !== undefined) fk.onDelete = onDelete;
    if (onUpdate !== undefined) fk.onUpdate = onUpdate;
    fks.push(fk);
  }
  return fks;
}

/**
 * Expand a `field.object @storage "flattened"` into one ColumnDescriptor per
 * nested field of the referenced value-object, prefixed by the parent field's
 * resolved column name + underscore.
 *
 * EF OwnsOne pattern: no JSON column for the parent itself; each nested field
 * becomes `<parent_col>_<nested_col>` in the owning entity's table.
 */
function flattenObjectField(
  field: MetaData, root: MetaRoot, strategy: ColumnNamingStrategy,
): ColumnDescriptor[] {
  // ADR-0039: resolving — @objectRef may be inherited via extends.
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return [];
  const targetObject = root.findObject(ref);
  if (targetObject === undefined) return [];
  const prefix = resolveColumnName(field, strategy) + "_";
  const cols: ColumnDescriptor[] = [];
  for (const nested of targetObject.fields()) {
    const inner = buildColumn(nested, /* isPk */ false, /* pkGeneration */ undefined, strategy);
    cols.push({ ...inner, name: prefix + inner.name });
  }
  return cols;
}

const EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^now\(\)$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(\)/,                             // anything function-like
];

function buildColumn(
  field: MetaData,
  isPk: boolean,
  pkGeneration: string | undefined,
  strategy: ColumnNamingStrategy,
): ColumnDescriptor {
  // Both the @required attr and the validator.required child signal NOT NULL.
  const fieldIsRequired = isRequired(field);
  // ADR-0039: resolving — @default may be inherited via extends.
  const defaultRaw = field.attr(FIELD_ATTR_DEFAULT);

  const col: ColumnDescriptor = {
    name: resolveColumnName(field, strategy),
    sqlType: subtypeToSqlType(field),
    nullable: !isPk && !fieldIsRequired,
  };

  if (typeof defaultRaw === "string") {
    // An INT-BACKED enum's @default names a MEMBER SYMBOL, but the column holds the
    // mapped integer — emitting `DEFAULT 'DRAFT'` on an `integer` column is
    // un-appliable DDL. Lower it through the map. The member is already validated
    // against @values by the loader (FR-011 Check 5), so a miss here is unreachable;
    // throw rather than silently emit the symbol, which would fail only at apply time.
    const enumIntMap = field.subType === FIELD_SUBTYPE_ENUM ? intValueMapOf(field) : undefined;
    if (enumIntMap !== undefined) {
      const mapped = enumIntMap[defaultRaw];
      if (typeof mapped !== "number") {
        throw new Error(
          `field.enum '${field.name}' @default '${defaultRaw}' has no entry in @intValueMap — ` +
            `cannot lower the column default for '${col.name}'.`,
        );
      }
      col.default = { kind: "literal", value: String(mapped) };
    } else {
      // #235: an EMPTY-string default (`@default: ""`) is a real literal default —
      // codegen emits `.default("")` and the DB gets `DEFAULT ''`, so dropping it here
      // (a falsy `.length > 0` check) made the column drift forever on sqlite/d1 and
      // disagree with codegen. Keep it as a literal; only `undefined` means "no default".
      const isExpr = defaultRaw.length > 0 && EXPR_DEFAULT_PATTERNS.some((re) => re.test(defaultRaw));
      col.default = { kind: isExpr ? "expr" : "literal", value: defaultRaw };
    }
  } else if (typeof defaultRaw === "boolean" || typeof defaultRaw === "number") {
    col.default = { kind: "literal", value: String(defaultRaw) };
  } else {
    // @autoSet stamps a timestamp column with the current time: "onCreate" on
    // insert, "onUpdate" on every write. Both need an insert-time DEFAULT so a
    // NOT NULL timestamp populates without an explicit value. (The per-update
    // refresh for "onUpdate" is the ORM/trigger's job, not the column default.)
    // An explicit @default always wins, so this only applies when none was set.
    // ADR-0039: resolving — @autoSet may be inherited via extends.
    const autoSet = field.attr(FIELD_ATTR_AUTO_SET);
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      col.default = { kind: "expr", value: "now()" };
    }
  }

  if (isPk && (pkGeneration === "increment" || pkGeneration === "uuid")) {
    col.identity = pkGeneration;
  }

  const fieldDesc = readDescription(field);
  if (fieldDesc !== undefined) col.description = fieldDesc;

  return col;
}

/**
 * The native Postgres array ELEMENT SqlType for an `isArray` scalar field, or
 * undefined when the subtype has no native-array form (object/map → single jsonb
 * column carrying the JSON array).
 *
 * MUST agree with codegen-ts's column-mapper, which emits Drizzle `.array()` for
 * EVERY scalar `@isArray` field on postgres (everything except object/map). When
 * this mapped only string/uuid, `field.int @isArray` got a SCALAR integer DB
 * column under an `integer("x").array()` Drizzle column — the first insert
 * failed (`column "x" is of type integer but expression is of type integer[]`)
 * with no drift signal, because both diff sides carried the same wrong scalar.
 *
 * Elements are deliberately UNQUALIFIED — bare `text` (no maxLength), bare
 * `numeric` (no precision/scale): information_schema reports NO qualifiers for
 * array elements (character_maximum_length / numeric_precision are NULL when
 * data_type = 'ARRAY'; verified on live PG 16), so a qualified expected element
 * could never converge with introspection and would churn change-column-type on
 * every run. The element qualifier is a codegen/validation concern, not a
 * migratable physical property.
 */
function arrayElementSqlType(field: MetaData): SqlType | undefined {
  switch (field.subType) {
    // enum[] stores as text[] — membership is app-level (no CHECK — see buildChecks).
    // An INT-BACKED enum[] (@intValueMap, design D7) stores as integer[] instead.
    case FIELD_SUBTYPE_ENUM:      return isIntBackedEnum(field) ? { kind: "integer", bits: 32 } : { kind: "text" };
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_URI:       return { kind: "text" };
    case FIELD_SUBTYPE_UUID:      return { kind: "uuid" };
    case FIELD_SUBTYPE_INT:       return { kind: "integer", bits: 32 };
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:  return { kind: "integer", bits: 64 };
    case FIELD_SUBTYPE_DOUBLE:    return { kind: "real" };
    case FIELD_SUBTYPE_FLOAT:     return { kind: "real4" };
    case FIELD_SUBTYPE_DECIMAL:   return { kind: "numeric" };
    case FIELD_SUBTYPE_BOOLEAN:   return { kind: "boolean" };
    case FIELD_SUBTYPE_DATE:      return { kind: "date" };
    case FIELD_SUBTYPE_TIME:      return { kind: "time" };
    case FIELD_SUBTYPE_TIMESTAMP:
      // ADR-0039: resolving — @localTime may be inherited via extends.
      return { kind: "timestamp", withTimezone: field.attr(FIELD_ATTR_LOCAL_TIME) !== true };
    case FIELD_SUBTYPE_INET:      return { kind: "inet" };
    default:                      return undefined; // object/map → single jsonb column
  }
}

function subtypeToSqlType(field: MetaData): SqlType {
  // R6 Plan 2b: a physical @dbColumnType override selects the DB column type
  // instead of the subtype default (the loader has already validated the
  // (subtype × value) pairing, so an unrecognized value never reaches here).
  // dbColumnType slim-and-derive Phase 1: the array overrides (uuid_array /
  // text_array) are RETIRED — native text[]/uuid[] are derived from `isArray`
  // below, not declared here. ADR-0036 Wave 2: `timestamp_with_tz` is RETIRED
  // too — field.timestamp is tz-aware by default + @localTime opts into naive
  // (handled in the subtype switch below), not via this physical escape hatch.
  // ADR-0039: @dbColumnType is the ONE deliberately own-only attr — a physical
  // column-type override is never inherited (a logical field extending a base
  // must not silently pick up the base's physical DB type). Keep ownAttr.
  const dbColumnType = field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
  if (typeof dbColumnType === "string") {
    switch (dbColumnType) {
      case DB_COLUMN_TYPE_UUID:  return { kind: "uuid" };
      case DB_COLUMN_TYPE_JSONB: return { kind: "json" };
    }
  }

  // Native array columns are DERIVED from `isArray` (dbColumnType slim-and-derive
  // Phase 1). Only scalar subtypes with a stable element SqlType get a native
  // Postgres array (e.g. field.string → text[], field.uuid → uuid[]). field.object
  // / field.map carry their array-ness inside a single jsonb column (no native
  // array — handled by the subtype switch returning { kind: "json" }).
  // ADR-0039: resolving — array-ness may be inherited via extends.
  if (field.resolvedIsArray()) {
    const element = arrayElementSqlType(field);
    if (element !== undefined) return { kind: "array", element };
  }

  const subType = field.subType;
  switch (subType) {
    case FIELD_SUBTYPE_STRING:    {
      // @maxLength is declared as ATTR_SUBTYPE_INT so the loader coerces it to a number.
      // ADR-0039: resolving — @maxLength may be inherited via extends.
      const m = field.attr(FIELD_ATTR_MAX_LENGTH);
      return typeof m === "number" ? { kind: "text", maxLength: m } : { kind: "text" };
    }
    case FIELD_SUBTYPE_INT:       return { kind: "integer", bits: 32 };
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:  return { kind: "integer", bits: 64 };
    case FIELD_SUBTYPE_DOUBLE:    return { kind: "real" };
    case FIELD_SUBTYPE_FLOAT:     return { kind: "real4" };
    case FIELD_SUBTYPE_DECIMAL:   {
      // @precision/@scale are declared as ATTR_SUBTYPE_INT so the loader coerces them
      // to numbers. Both present → NUMERIC(p,s); absent → bare NUMERIC (back-compat).
      // ADR-0039: resolving — @precision / @scale may be inherited via extends.
      const precision = field.attr(FIELD_ATTR_PRECISION);
      const scale = field.attr(FIELD_ATTR_SCALE);
      if (typeof precision === "number" && typeof scale === "number") {
        return { kind: "numeric", precision, scale };
      }
      // NUMERIC(p) IS NUMERIC(p,0) — the SQL standard defaults an omitted scale
      // to zero, and Postgres stores it that way (information_schema reports
      // numeric_scale = 0, not NULL). Model the scale the database will actually
      // hold, or expected (bare p) and introspected (p, 0) can never converge and
      // the column churns change-column-type on every migrate.
      if (typeof precision === "number") {
        return { kind: "numeric", precision, scale: 0 };
      }
      return { kind: "numeric" };
    }
    case FIELD_SUBTYPE_BOOLEAN:   return { kind: "boolean" };
    case FIELD_SUBTYPE_DATE:      return { kind: "date" };
    case FIELD_SUBTYPE_TIME:      return { kind: "time" }; // Postgres native TIME (whole-second wire form)
    case FIELD_SUBTYPE_TIMESTAMP:
      // ADR-0036 Wave 2: instant / tz-aware BY DEFAULT (→ timestamptz). A naive
      // wall-clock value opts out with @localTime:true (→ TIMESTAMP, no tz).
      // ADR-0039: resolving — @localTime may be inherited via extends.
      return { kind: "timestamp", withTimezone: field.attr(FIELD_ATTR_LOCAL_TIME) !== true };
    case FIELD_SUBTYPE_OBJECT:
    case FIELD_SUBTYPE_MAP:       return { kind: "json" }; // field.map → single jsonb (pg) / text-json (sqlite) column
    case FIELD_SUBTYPE_UUID:      return { kind: "uuid" }; // R6 Plan 2a — Postgres native uuid
    case FIELD_SUBTYPE_URI:       return { kind: "text" }; // ADR-0036/0037 Wave 3 — no Postgres uri type → text
    // ADR-0036/0037 Wave 3 — Postgres-native inet. #234: a @lenient field.inet
    // stores as text (the native inet column would reject a not-strictly-valid
    // value at INSERT). ADR-0039: resolving — @lenient may be inherited via extends.
    case FIELD_SUBTYPE_INET:      return field.attr(FIELD_ATTR_LENIENT) === true ? { kind: "text" } : { kind: "inet" };
    // A string-backed field.enum is a text column with a membership CHECK; an
    // INT-BACKED one (@intValueMap, design D5) stores the mapped integer instead.
    // The TS/wire type is the member string either way — only the column differs.
    case FIELD_SUBTYPE_ENUM:      return isIntBackedEnum(field) ? { kind: "integer", bits: 32 } : { kind: "text" };
    default:                      return { kind: "text" }; // unknown → text fallback
  }
}

/**
 * True when this `field.enum` persists as an integer — i.e. it carries an
 * `@intValueMap` (design D5).
 *
 * ADR-0039: RESOLVING (`attr`, not `ownAttr`). Post-#246 a shared (root-level
 * abstract) enum OWNS the map and consuming fields inherit it — declaring an own
 * `@intValueMap` against a shared super is `ERR_ENUM_EXTENDS_VALUES_CONFLICT`. So
 * the inherited case is not an edge case, it is the CANONICAL authoring shape, and
 * an own-only read here would emit a `text` column for an integer-encoded value on
 * every consuming field of every shared enum.
 */
function isIntBackedEnum(field: MetaData): boolean {
  return intValueMapOf(field) !== undefined;
}

/** The resolved `@intValueMap` as a plain record, or undefined when absent. */
export function intValueMapOf(field: MetaData): Record<string, number> | undefined {
  const raw = field.attr(FIELD_ATTR_INT_VALUE_MAP);
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as Record<string, number>;
}

