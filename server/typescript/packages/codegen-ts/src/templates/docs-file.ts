// Docs-file template — emits a Markdown documentation page for one entity.
//
// One `<Entity>.md` file per object.entity / object.value. Documents:
//   - Description / type / source / package preamble
//   - Storage table (writable source.rdb only): per-field TypeScript type, SQL
//     column expression, and constraints
//   - Identity (primary, secondary, reference)
//   - Relationships (own composition / aggregation / association children, plus
//     incoming reference identities)
//   - Validation entry points (Zod schemas exported from <Entity>.ts)
//   - "Used by" — any template.* node whose @payloadRef points at this entity
//   - Generated-code surface (which sibling files codegen produces)
//
// All output is plain Markdown; no ts-poet involvement. Byte-stable: identical
// metadata input always produces identical output (the conformance runner
// asserts byte equality against `expected/<Entity>.md`).
//
// Skipped sections on object.value: Storage / Identity / Relationships.

import {
  type MetaObject,
  type MetaField,
  type MetaIdentity,
  type MetaRoot,
  TYPE_TEMPLATE,
  TEMPLATE_ATTR_PAYLOAD_REF,
  OBJECT_SUBTYPE_VALUE,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_ATTR_GENERATION,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_SUBTYPE_COMPOSITION,
  RELATIONSHIP_SUBTYPE_AGGREGATION,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_DEFAULT,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  DOC_ATTR_DESCRIPTION,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { mapColumnType, type Dialect } from "../column-mapper.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { toPascalCase } from "../naming.js";
import { enumValues } from "../enum-meta.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { GENERATED_HEADER } from "../constants.js";

/**
 * Options for the markdown emitter. Mirrors the bits of `RenderContext` it
 * actually needs (dialect + column-naming-strategy + cross-entity loader).
 * Held as a separate type so unit tests can call `renderDocsFile()` without
 * constructing a full `RenderContext`.
 */
export interface DocsRenderOpts {
  dialect: Dialect;
  columnNamingStrategy?: ColumnNamingStrategy;
  loadedRoot: MetaRoot;
  /** Names of generators present in the pipeline — drives the "Generated code"
   *  section. Always includes "entity-file" implicitly. Recognized names:
   *  "queries-file", "routes-file", "routes-file-hono". */
  generatorNames?: ReadonlySet<string>;
}

/** Scalar field.subType → TypeScript scalar mapping. Mirrors inferred-types.ts. */
const SCALAR_TS_BY_SUBTYPE: Record<string, string> = {
  [FIELD_SUBTYPE_STRING]: "string",
  [FIELD_SUBTYPE_CLASS]: "string",
  [FIELD_SUBTYPE_INT]: "number",
  [FIELD_SUBTYPE_SHORT]: "number",
  [FIELD_SUBTYPE_BYTE]: "number",
  [FIELD_SUBTYPE_LONG]: "number",
  [FIELD_SUBTYPE_DOUBLE]: "number",
  [FIELD_SUBTYPE_FLOAT]: "number",
  [FIELD_SUBTYPE_DECIMAL]: "number",
  [FIELD_SUBTYPE_CURRENCY]: "number",
  [FIELD_SUBTYPE_BOOLEAN]: "boolean",
  [FIELD_SUBTYPE_DATE]: "string",
  [FIELD_SUBTYPE_TIME]: "string",
  [FIELD_SUBTYPE_TIMESTAMP]: "string",
};

/** Mirror inferred-types.ts's enumTypeAliasName. */
function enumTypeAliasName(entity: MetaObject, field: MetaField): string {
  const superField = field.resolveSuper();
  return superField !== undefined
    ? toPascalCase(superField.name)
    : `${entity.name}${toPascalCase(field.name)}`;
}

/**
 * The TS type column shown in the Storage table — equivalent to what
 * `InferSelectModel<typeof <table>>` produces. For required (or PK) → bare;
 * for optional → `T | null` (Drizzle nullable columns surface as `null`, not
 * `undefined`, on select).
 */
function tsTypeForStorage(
  entity: MetaObject,
  field: MetaField,
  pkFieldNames: ReadonlySet<string>,
): string {
  let base: string;

  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      // For storage we show the literal union directly (matches what Drizzle
      // infers via `text(..., { enum: [...] as const })` on a single-column).
      // For arrays we use the alias name to keep the table tidy.
      if (field.isArray) {
        base = `${enumTypeAliasName(entity, field)}[]`;
      } else {
        base = values.map((v) => JSON.stringify(v)).join(" | ");
      }
    } else {
      base = field.isArray ? "string[]" : "string";
    }
  } else if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    const refName = typeof ref === "string" && ref.length > 0 ? ref : "unknown";
    base = field.isArray ? `${refName}[]` : refName;
  } else {
    const scalar = SCALAR_TS_BY_SUBTYPE[field.subType] ?? "unknown";
    base = field.isArray ? `${scalar}[]` : scalar;
  }

  // Primary-key columns are always NOT NULL on the select side regardless of
  // an explicit @required attr; Drizzle's `.primaryKey()` implies notNull.
  // Required fields likewise come through as bare T. Optional → T | null.
  const required = pkFieldNames.has(field.name) || isFieldRequired(field);
  return required ? base : `${base} | null`;
}

/** True iff the field is required (own @required or validator.required, effective). */
function isFieldRequired(field: MetaField): boolean {
  if (field.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
  return field.validators().some((v) => v.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

/**
 * The SQL column column — the literal Drizzle call (function + args).
 * Mirrors what `mapColumnType()` + `renderColumn()` emit, minus the chain
 * modifiers (those land in Constraints).
 */
function sqlColumnExpr(spec: ReturnType<typeof mapColumnType>): string {
  const dbName = JSON.stringify(spec.dbName);
  if (spec.fnOptions !== undefined && Object.keys(spec.fnOptions).length > 0) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(spec.fnOptions)) {
      const lit = JSON.stringify(v);
      if (Array.isArray(v)) {
        parts.push(`${k}: ${lit} as const`);
      } else {
        parts.push(`${k}: ${lit}`);
      }
    }
    return `${spec.fnName}(${dbName}, { ${parts.join(", ")} })`;
  }
  return `${spec.fnName}(${dbName})`;
}

/**
 * Build the Constraints cell text for one field. Pure description — not
 * exhaustive of every Drizzle modifier emitted, but covers the contract-level
 * shape (required / optional, PK, JSON, CHECK, regex, length, numeric bounds,
 * FK references, extends:).
 */
function constraintsCell(
  entity: MetaObject,
  field: MetaField,
  pkFieldNames: Set<string>,
  fkMap: Map<string, { targetEntity: string; targetField: string }>,
): string {
  const parts: string[] = [];

  if (pkFieldNames.has(field.name)) {
    parts.push("primary key");
    const primary = entity.primaryIdentity();
    const gen = primary?.ownAttr(IDENTITY_ATTR_GENERATION);
    if (typeof gen === "string") {
      parts.push(`generation: \`${gen}\``);
    }
  } else if (isFieldRequired(field)) {
    parts.push("required");
  } else {
    parts.push("optional");
  }

  if (field.ownAttr(FIELD_ATTR_UNIQUE) === true) {
    parts.push("unique");
  }

  if (field.isArray) {
    parts.push("JSON column");
  }

  // Enum CHECK predicate.
  if (field.subType === FIELD_SUBTYPE_ENUM && !field.isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
      // Use the strategy-mapped column name to mirror the emitted CHECK constraint.
      parts.push(`CHECK \`${field.column ?? field.name} IN (${list})\``);
    }
  }

  // Regex pattern.
  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string" && pattern.length > 0) {
        parts.push(`pattern \`${pattern}\``);
      }
    }
  }

  // Length bounds (validator.length / @maxLength).
  const maxLenAttr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  if (typeof maxLenAttr === "number") {
    parts.push(`maxLength: ${maxLenAttr}`);
  }
  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") parts.push(`minLength: ${min}`);
      if (typeof max === "number" && typeof maxLenAttr !== "number") parts.push(`maxLength: ${max}`);
    }
  }

  // Numeric bounds.
  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") parts.push(`min: ${min}`);
      if (typeof max === "number") parts.push(`max: ${max}`);
    }
  }

  // Foreign key (incoming side via reference identity).
  const fk = fkMap.get(field.name);
  if (fk !== undefined) {
    parts.push(`references \`${fk.targetEntity}.${fk.targetField}\``);
  }

  // Default expression — the actual literal/sql shape is implementation detail;
  // surface the raw declared default so the reader can see "what's the default."
  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  if (def !== undefined) {
    parts.push(`default: \`${String(def)}\``);
  }

  // Extends: surface the abstract super field name for traceability.
  const sup = field.resolveSuper();
  if (sup !== undefined) {
    parts.push(`extends \`${sup.name}\``);
  }

  return parts.join(", ");
}

/** Build the FK lookup for the entity's own reference identities. */
function buildFkMap(
  entity: MetaObject,
  root: MetaRoot,
): Map<string, { targetEntity: string; targetField: string }> {
  const out = new Map<string, { targetEntity: string; targetField: string }>();
  for (const ref of entity.referenceIdentities()) {
    const fkField = ref.fields[0];
    const targetEntity = ref.targetEntity;
    if (fkField === undefined || targetEntity === undefined) continue;
    const targetField = ref.resolvedTargetPkField(root) ?? "id";
    out.set(fkField, { targetEntity: stripPackage(targetEntity), targetField });
  }
  return out;
}

/** Resolve provenance from the node's source envelope — best-effort. */
function sourceLine(entity: MetaObject): string | undefined {
  const src = entity.source;
  if (!src) return undefined;
  if ("files" in src && src.files.length > 0) {
    // Mention the first file. Use the path verbatim — node IDs from
    // InMemoryStringSource (e.g. "meta.blog.json") or file system paths
    // (e.g. "metaobjects/meta-author.yaml") both read naturally here.
    return src.files[0];
  }
  if (src.format === "code") {
    return src.caller !== undefined ? `(code) ${src.caller}` : "(code)";
  }
  return undefined;
}

/** Description from the entity's @description doc-attr (effective). */
function entityDescription(entity: MetaObject): string | undefined {
  const v = entity.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Render the Storage section (a markdown table). */
function renderStorageSection(
  entity: MetaObject,
  opts: DocsRenderOpts,
): string {
  const strategy = opts.columnNamingStrategy ?? "snake_case";
  const primary = entity.primaryIdentity();
  const pkFields = primary?.fields ?? [];
  const pkFieldNames = new Set<string>(pkFields);
  const fkMap = buildFkMap(entity, opts.loadedRoot);

  const rows: string[] = [];
  rows.push("| Field | TypeScript type | SQL column | Constraints |");
  rows.push("|---|---|---|---|");
  for (const field of entity.fields()) {
    const spec = mapColumnType(field, opts.dialect, strategy);
    const tsType = tsTypeForStorage(entity, field, pkFieldNames);
    const sqlExpr = sqlColumnExpr(spec);
    const cons = constraintsCell(entity, field, pkFieldNames, fkMap);
    // Wrap each cell in backticks where appropriate to keep table alignment
    // readable. The pipe character is escaped so Drizzle's `text(..., { enum: [...] })`
    // and TS literal unions ("a" | "b") render cleanly inside one cell.
    const tsTypeCell = tsType.split("|").map((s) => s.trim()).join(" \\| ");
    const sqlCell = `\`${sqlExpr}\``;
    rows.push(`| \`${field.name}\` | \`${tsTypeCell}\` | ${sqlCell} | ${cons} |`);
  }

  return `## Storage\n\n${rows.join("\n")}`;
}

/** Render the Identity section as bullets. */
function renderIdentitySection(entity: MetaObject): string | undefined {
  const ids = entity.identities();
  if (ids.length === 0) return undefined;

  const bullets: string[] = [];
  for (const id of ids) {
    bullets.push(`- ${describeIdentity(id)}`);
  }
  return `## Identity\n\n${bullets.join("\n")}`;
}

function describeIdentity(id: MetaIdentity): string {
  const fields = id.fields;
  const fieldList = fields.length === 1
    ? `\`${fields[0]}\``
    : `(${fields.map((f) => `\`${f}\``).join(", ")})`;

  if (id.subType === IDENTITY_SUBTYPE_PRIMARY) {
    const gen = id.ownAttr(IDENTITY_ATTR_GENERATION);
    const genSuffix = typeof gen === "string" ? ` — generation: \`${gen}\`` : "";
    return `**Primary key:** ${fieldList}${genSuffix}`;
  }
  if (id.subType === IDENTITY_SUBTYPE_SECONDARY) {
    const uniqueText = id.unique ? "unique" : "non-unique";
    return `**Secondary index:** ${fieldList} — ${uniqueText}`;
  }
  if (id.subType === IDENTITY_SUBTYPE_REFERENCE) {
    // Reference identity carries @references = "TargetEntity[.field]"
    const refIdent = id as unknown as { referencesRaw?: string };
    const raw = refIdent.referencesRaw;
    if (typeof raw === "string" && raw.length > 0) {
      return `**Reference:** ${fieldList} → \`${raw}\``;
    }
    return `**Reference:** ${fieldList}`;
  }
  return `**Identity (${id.subType}):** ${fieldList}`;
}

/** Render the Relationships section as bullets. */
function renderRelationshipsSection(entity: MetaObject): string | undefined {
  const rels = entity.relationships();
  if (rels.length === 0) return undefined;

  const bullets: string[] = [];
  for (const r of rels) {
    const cardinality = r.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
    const card = typeof cardinality === "string" ? cardinality : "?";
    const targetRaw = r.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);
    const target = typeof targetRaw === "string" ? stripPackage(targetRaw) : "?";
    const subtype = r.subType;
    let label: string;
    switch (subtype) {
      case RELATIONSHIP_SUBTYPE_COMPOSITION:
        label = "composition";
        break;
      case RELATIONSHIP_SUBTYPE_AGGREGATION:
        label = "aggregation";
        break;
      case RELATIONSHIP_SUBTYPE_ASSOCIATION:
        label = "association";
        break;
      default:
        label = subtype;
    }
    bullets.push(`- \`${r.name}\` — ${card} → \`${target}\` (${label})`);
  }
  return `## Relationships\n\n${bullets.join("\n")}`;
}

/** Render the Validation section — pointers at the Zod schemas. */
function renderValidationSection(entity: MetaObject): string {
  const lower = entity.name.charAt(0).toLowerCase() + entity.name.slice(1);
  const lines = [
    `- \`${entity.name}InsertSchema\` (Zod) — for creating new ${lower}s.`,
    `- \`${entity.name}UpdateSchema\` (Zod) — for partial updates.`,
    `- See \`${entity.name}.ts\` for the exported schemas.`,
  ];
  return `## Validation\n\n${lines.join("\n")}`;
}

/** Render the "Used by" section — templates that declare @payloadRef → this entity. */
function renderUsedBySection(entity: MetaObject, root: MetaRoot): string | undefined {
  const matches: string[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_TEMPLATE) continue;
    const ref = child.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    if (typeof ref !== "string") continue;
    if (stripPackage(ref) !== entity.name) continue;
    matches.push(`- \`template.${child.subType} ${child.name}\` — uses \`${entity.name}\` as \`@payloadRef\``);
  }
  if (matches.length === 0) return undefined;
  return `## Used by\n\n${matches.join("\n")}`;
}

/** Render the Generated-code section — sibling files this entity produces. */
function renderGeneratedCodeSection(entity: MetaObject, opts: DocsRenderOpts): string {
  const gens = opts.generatorNames ?? new Set<string>();
  const isValue = entity.subType === OBJECT_SUBTYPE_VALUE;
  const lower = entity.name.charAt(0).toLowerCase() + entity.name.slice(1);
  const lines: string[] = [];
  lines.push(`- \`${entity.name}.ts\` — Drizzle table, Zod schemas, type aliases, enum literal unions.`);
  // Queries are only emitted for non-value entities (queriesFile() unconditionally
  // skips object.value).
  if (gens.has("queries-file") && !isValue) {
    lines.push(`- \`${entity.name}.queries.ts\` — typed CRUD helpers (find / list / create / update / delete; takes \`db\` as first param per ADR-0008).`);
  }
  if (gens.has("routes-file") && !isValue) {
    lines.push(`- \`${entity.name}.routes.ts\` — Fastify CRUD-5 route registration (\`register${entity.name}Routes\`).`);
  }
  if (gens.has("routes-file-hono") && !isValue) {
    lines.push(`- \`${entity.name}.routes.hono.ts\` — Hono CRUD-5 route registration (\`register${entity.name}Routes\`).`);
  }
  // Silence the unused `lower` warning — kept for future expansion.
  void lower;
  return `## Generated code\n\n${lines.join("\n")}`;
}

/**
 * Top-level: render the full markdown page for one entity / value object.
 *
 * Sections (object.entity with source.rdb):
 *   # <Name>
 *   > <description>?
 *   **Type:** ...
 *   **Source:** ...
 *   **Package:** ...
 *
 *   ## Storage
 *   ## Identity
 *   ## Relationships  (when present)
 *   ## Validation
 *   ## Used by  (when present)
 *   ## Generated code
 *
 * Sections (object.value, or any object lacking source.rdb):
 *   # <Name>
 *   > <description>?
 *   **Type:** ...
 *   **Source:** ...
 *   **Package:** ...
 *
 *   ## Validation
 *   ## Used by  (when present)
 *   ## Generated code
 */
export function renderDocsFile(entity: MetaObject, opts: DocsRenderOpts): string {
  const parts: string[] = [];

  // HTML comment header carrying the @generated marker — drives the
  // overwrite-policy so subsequent `meta gen` runs can refresh the file
  // without confirmation. Hidden in rendered markdown (HTML comments don't
  // surface in GitHub / VS Code / mdBook output) but visible in raw source.
  parts.push(`<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`);

  parts.push(`# ${entity.name}`);

  const desc = entityDescription(entity);
  if (desc !== undefined) {
    // Each non-empty line of the description becomes a quote line — keeps
    // multi-paragraph descriptions readable.
    const lines = desc.split("\n");
    parts.push(lines.map((l) => `> ${l}`.trimEnd()).join("\n"));
  }

  const headerLines: string[] = [];
  headerLines.push(`**Type:** \`${entity.type}.${entity.subType}\``);
  const src = sourceLine(entity);
  if (src !== undefined) {
    headerLines.push(`**Source:** \`${src}\``);
  }
  if (entity.package !== undefined && entity.package !== "") {
    headerLines.push(`**Package:** \`${entity.package}\``);
  }
  parts.push(headerLines.join("\n"));

  const hasStorage = entity.subType !== OBJECT_SUBTYPE_VALUE && hasWritableRdbSource(entity);

  if (hasStorage) {
    parts.push(renderStorageSection(entity, opts));
    const id = renderIdentitySection(entity);
    if (id !== undefined) parts.push(id);
    const rel = renderRelationshipsSection(entity);
    if (rel !== undefined) parts.push(rel);
  }

  parts.push(renderValidationSection(entity));

  const usedBy = renderUsedBySection(entity, opts.loadedRoot);
  if (usedBy !== undefined) parts.push(usedBy);

  parts.push(renderGeneratedCodeSection(entity, opts));

  // Join sections with a blank line, single trailing newline.
  return parts.map((s) => s.trimEnd()).join("\n\n") + "\n";
}
