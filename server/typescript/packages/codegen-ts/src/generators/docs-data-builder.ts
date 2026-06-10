// Helper that turns a MetaObject (+ root) into the EntityDocData shape the
// templates consume. The previous hand-coded `renderDocsFile()` mixed data
// extraction with string emission; this module is the data-only half — the
// markdown structure now lives in templates/docs/entity-page.md.mustache.

import {
  type MetaObject,
  type MetaField,
  type MetaIdentity,
  type MetaReferenceIdentity,
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
  RELATIONSHIP_ATTR_THROUGH,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  RELATIONSHIP_ATTR_SYMMETRIC,
  RELATIONSHIP_SUBTYPE_COMPOSITION,
  RELATIONSHIP_SUBTYPE_AGGREGATION,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
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
  DOC_ATTR_SUMMARY,
  FIELD_ATTR_DB_COLUMN_TYPE,
  stripPackage,
} from "@metaobjectsdev/metadata";
import type { Dialect } from "../column-mapper.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import type { OutputLayout } from "../import-path.js";
import { docPageHref, docPageNode } from "../docs-paths.js";
import { fieldAnchorHtml } from "./field-anchor.js";
import { enumValues } from "../enum-meta.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { GENERATED_HEADER } from "../constants.js";
import { renderEntityNeighborhoodErBlock } from "../templates/mermaid-er.js";
import type {
  EntityDocData,
  StorageFieldDoc,
  IdentityDoc,
  RelationshipDoc,
  UsedByDoc,
  ConstraintRow,
  FieldDoc,
  FieldDetailDoc,
} from "./docs-data.js";

export interface BuildDocDataOpts {
  dialect: Dialect;
  columnNamingStrategy?: ColumnNamingStrategy;
  loadedRoot: MetaRoot;
  /** Page-placement layout. Defaults to "flat" (back-compat: same-dir links). */
  layout?: OutputLayout;
  /** Cross-links to this entity's GENERATED-SDK api pages, one per api surface
   *  (per language). Computed by the caller (docsFile) via the shared
   *  `apiSurfaceHref` so each resolves in BOTH layouts. ABSENT for model-only
   *  runs → default output byte-identical. */
  apiRefs?: Array<{ label: string; href: string }>;
}

/** Whether a field is required — `@required` true OR a `validator.required`
 *  child. The SINGLE source of truth for required-ness across the Constraints
 *  table, the Storage nullable rule, and (via the api-docs field-shape builder)
 *  the documented model-field optionality. Exported so the field-shape builder
 *  reuses the EXACT same rule rather than re-deriving it. */
export function isFieldRequired(field: MetaField): boolean {
  if (field.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
  return field.validators().some((v) => v.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

/** The raw validator/limit facts for the Constraints table. Walks the field's
 *  validators ONCE, bucketed by subtype, plus the `@maxLength` attr.
 *  `buildConstraintRow()` consumes these — the SINGLE source of truth for the
 *  validator emission. The emission ORDER and exact strings come from here:
 *    regex pattern → maxLength-from-@maxLength → length-validator (min/max) →
 *    numeric-validator (min/max). */
interface ValidatorParts {
  /** `@maxLength` attr value if a finite number, else undefined. */
  maxLenAttr: number | undefined;
  /** "pattern `...`" entries from regex validators. */
  regexParts: string[];
  /** "minLength: N" / "maxLength: N" entries from length validators. */
  lengthParts: string[];
  /** "min: N" / "max: N" entries from numeric validators. */
  numericParts: string[];
}

function collectValidatorParts(field: MetaField): ValidatorParts {
  const maxLenAttr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  const regexParts: string[] = [];
  const lengthParts: string[] = [];
  const numericParts: string[] = [];
  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string" && pattern.length > 0) {
        regexParts.push(`pattern \`${pattern}\``);
      }
    } else if (v.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") lengthParts.push(`minLength: ${min}`);
      if (typeof max === "number" && typeof maxLenAttr !== "number") lengthParts.push(`maxLength: ${max}`);
    } else if (v.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") numericParts.push(`min: ${min}`);
      if (typeof max === "number") numericParts.push(`max: ${max}`);
    }
  }
  return {
    maxLenAttr: typeof maxLenAttr === "number" ? maxLenAttr : undefined,
    regexParts,
    lengthParts,
    numericParts,
  };
}

/** The NEUTRAL logical type string (no backticks): the field's logical
 *  subtype (e.g. `string`, `enum`, `decimal`), suffixed `[]` for arrays, and
 *  the referenced object name for `field.object`. Language-agnostic — built
 *  from declared metadata, never re-derived into ANSI/ORM SQL. Shared by the
 *  Constraints table (`neutralTypeCell`) and the Storage table's physical-type
 *  fallback (`storageTypeCell`). */
export function neutralTypeStr(field: MetaField): string {
  let base: string;
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    base = typeof ref === "string" && ref.length > 0 ? stripPackage(ref) : "object";
  } else {
    base = field.subType;
  }
  if (field.isArray) base = `${base}[]`;
  return base;
}

/** Neutral logical type cell for the Constraints table — `neutralTypeStr`
 *  wrapped in backticks. */
function neutralTypeCell(field: MetaField): string {
  return `\`${neutralTypeStr(field)}\``;
}

/** Neutral PHYSICAL type cell for the Storage table. Metadata-driven, no DDL
 *  re-derivation (ADR-0020): if the field declares a `@dbColumnType` physical
 *  override (e.g. `uuid`, `jsonb`, `timestamp_with_tz`) show it UPPERCASED;
 *  otherwise fall back to the same neutral LOGICAL type the Constraints table
 *  uses. Deliberately does NOT derive ANSI/ORM SQL so it can't drift vs the
 *  migrate engine or re-introduce language-specific DDL. Wrapped in backticks. */
function storageTypeCell(field: MetaField): string {
  const dbColumnType = field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
  if (typeof dbColumnType === "string" && dbColumnType.length > 0) {
    return `\`${dbColumnType.toUpperCase()}\``;
  }
  return `\`${neutralTypeStr(field)}\``;
}

/** Build one neutral Constraints-table row for a field. Reuses the same
 *  per-field constraint logic as `constraintsCell()` (required-ness, maxLength,
 *  enum CHECK-sets, validators, default, unique, references), but splits the
 *  facts across the Required / Limits / Rules columns instead of one cell.
 *  Renders for every field, with or without storage. */
function buildConstraintRow(
  entity: MetaObject,
  field: MetaField,
  pkFieldNames: Set<string>,
  fkMap: Map<string, { targetEntity: string; targetField: string }>,
): ConstraintRow {
  const isPk = pkFieldNames.has(field.name);
  const required = isPk || isFieldRequired(field);

  const limits: string[] = [];
  const rules: string[] = [];

  if (isPk) rules.push("primary key");
  if (field.ownAttr(FIELD_ATTR_UNIQUE) === true) rules.push("unique");

  if (field.subType === FIELD_SUBTYPE_ENUM && !field.isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const list = values.map((v) => `\`${v}\``).join(", ");
      rules.push(`one of ${list}`);
    }
  }

  // Same validator facts as constraintsCell() (shared walk), arranged across
  // the Limits / Rules columns instead of one cell.
  const { maxLenAttr, regexParts, lengthParts, numericParts } = collectValidatorParts(field);
  rules.push(...regexParts);
  if (maxLenAttr !== undefined) limits.push(`maxLength: ${maxLenAttr}`);
  limits.push(...lengthParts, ...numericParts);

  const fk = fkMap.get(field.name);
  if (fk !== undefined) {
    rules.push(`references \`${fk.targetEntity}.${fk.targetField}\``);
  }

  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  if (def !== undefined) rules.push(`default: \`${String(def)}\``);

  const sup = field.resolveSuper();
  if (sup !== undefined) rules.push(`extends \`${sup.name}\``);

  return {
    // The Field cell carries a stable HTML anchor (`<a id="field-<name>">`)
    // before the backticked name, so the template-source annotator's
    // `#field-<name>` links resolve. Slug = `fieldAnchorSlug(name)` — the SINGLE
    // source shared with the annotator so anchor and link can't drift. The
    // anchor is a language-independent HTML id, so the page stays neutral.
    field: `${fieldAnchorHtml(field.name)}\`${field.name}\``,
    required: required ? "yes" : "",
    type: neutralTypeCell(field),
    limits: limits.join(", "),
    rules: rules.join(", "),
  };
}

/** Build one row of the unified Fields table — collapses the per-field facts
 *  the old Storage + Constraints tables split between into a single Markdown
 *  row. PK/FK key role becomes a glyph prefix on the Field cell, the FK
 *  target becomes a `→ \`Target\`` suffix on the Type cell, the @column
 *  override (only when interesting) lands in the Storage cell, everything
 *  else (validators, defaults, enum CHECK-sets, references, unique, extends)
 *  goes into the Rules cell joined by " · ".
 *
 *  Identity bullets remain a separate section above — they describe the
 *  *identity declarations* (composite keys, generation strategy, reference
 *  topology), not the per-field facts. */
function buildFieldRow(
  entity: MetaObject,
  field: MetaField,
  pkFieldNames: Set<string>,
  fkMap: Map<string, { targetEntity: string; targetField: string }>,
): FieldDoc {
  const isPk = pkFieldNames.has(field.name);
  const fk = fkMap.get(field.name);
  const required = isPk || isFieldRequired(field);

  // Field cell — anchor + glyph + name.
  let glyph = "";
  if (isPk) glyph = "🔑 ";
  else if (fk !== undefined) glyph = "🔗 ";
  const fieldCell = `${fieldAnchorHtml(field.name)}${glyph}\`${field.name}\``;

  // Type cell — neutral logical type; for FK, append the target as a link.
  let typeCell = neutralTypeCell(field);
  if (fk !== undefined) {
    typeCell = `${typeCell} → \`${fk.targetEntity}\``;
  }

  // Storage cell — only populated when interesting:
  //   - @column override that differs from the field name, OR
  //   - @dbColumnType physical override set
  // Otherwise empty. Keeps the column noise-free for the 90% case where
  // field name and column name agree.
  const columnName = field.column;
  const dbColumnType = field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
  const columnDiffers = typeof columnName === "string" && columnName !== field.name;
  const hasPhysicalOverride = typeof dbColumnType === "string" && dbColumnType.length > 0;
  let storageCell = "";
  if (columnDiffers && hasPhysicalOverride) {
    storageCell = `\`${columnName}\` \`${dbColumnType!.toUpperCase()}\``;
  } else if (columnDiffers) {
    storageCell = `\`${columnName}\``;
  } else if (hasPhysicalOverride) {
    storageCell = `\`${dbColumnType!.toUpperCase()}\``;
  }

  // Rules cell — joined facts. Same logic as buildConstraintRow's Rules
  // column, plus the maxLength/length/numeric limits that used to live in
  // the separate Limits cell (collapsed in to keep the table to 5 columns).
  const rules: string[] = [];
  if (field.ownAttr(FIELD_ATTR_UNIQUE) === true) rules.push("unique");

  if (field.subType === FIELD_SUBTYPE_ENUM && !field.isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const list = values.map((v) => `\`${v}\``).join(", ");
      rules.push(`one of ${list}`);
    }
  }

  const { maxLenAttr, regexParts, lengthParts, numericParts } = collectValidatorParts(field);
  rules.push(...regexParts);
  if (maxLenAttr !== undefined) rules.push(`maxLength: ${maxLenAttr}`);
  rules.push(...lengthParts, ...numericParts);

  // The FK reference is already encoded in typeCell — don't repeat it in rules.
  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  if (def !== undefined) rules.push(`default: \`${String(def)}\``);

  const sup = field.resolveSuper();
  if (sup !== undefined) rules.push(`extends \`${sup.name}\``);

  return {
    field: field.name,
    fieldCell,
    typeCell,
    requiredCell: required ? "yes" : "",
    storageCell,
    rulesCell: rules.join(" · "),
  };
}

/** Build an expanded per-field detail block — `### \`name\`` heading, italic
 *  @summary lead-in, @description paragraph, then a bullet list of every
 *  notable rule (validators, default, FK, extends-enum, column override).
 *  Returns `undefined` when the field has nothing extra to say (just type +
 *  required) — the caller filters these out so the section stays tight.
 *
 *  The validator list is the most important value-add: the Fields table
 *  collapses `pattern \`X\` · maxLength: 200 · minLength: 3` into a single
 *  Rules cell; this section breaks them out as individual bullets so the
 *  reader can scan each rule on its own line. */
function buildFieldDetail(
  field: MetaField,
  pkFieldNames: Set<string>,
  fkMap: Map<string, { targetEntity: string; targetField: string }>,
): FieldDetailDoc | undefined {
  const desc = field.attr(DOC_ATTR_DESCRIPTION);
  const summary = field.attr(DOC_ATTR_SUMMARY);
  const hasDesc = typeof desc === "string" && desc.length > 0;
  const hasSummary = typeof summary === "string" && summary.length > 0;
  const sup = field.resolveSuper();
  const fk = fkMap.get(field.name);
  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  const columnName = field.column;
  const dbColumnType = field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
  const isUnique = field.ownAttr(FIELD_ATTR_UNIQUE) === true;
  const isEnum = field.subType === FIELD_SUBTYPE_ENUM && !field.isArray;
  const enumVals = isEnum ? enumValues(field) : undefined;
  const validators = field.validators();
  const hasValidatorChildren = validators.some(
    v => v.subType === VALIDATOR_SUBTYPE_LENGTH
      || v.subType === VALIDATOR_SUBTYPE_REGEX
      || v.subType === VALIDATOR_SUBTYPE_NUMERIC,
  );
  const maxLenAttr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);

  // "Interesting enough to render a detail block" predicate. Plain typed
  // fields with no authored annotations get skipped — the at-a-glance Fields
  // table covered them already.
  //
  // Deliberately NOT counted as "interesting":
  //   - PK / required-ness (already a column in the table)
  //   - mechanical @column overrides (adopters typically set
  //     @column: PascalCase(name) wholesale; surfacing every field for
  //     that alone would defeat the section's purpose)
  // The detail section's value is surfacing AUTHORED docs + validators +
  // business rules, not physical column mapping.
  const isInteresting =
    hasDesc
    || hasSummary
    || sup !== undefined
    || fk !== undefined
    || def !== undefined
    || hasValidatorChildren
    || typeof maxLenAttr === "number"
    || (enumVals !== undefined && enumVals.length > 0)
    || isUnique
    || (typeof dbColumnType === "string" && dbColumnType.length > 0);
  if (!isInteresting) return undefined;

  const parts: string[] = [`### \`${field.name}\``];

  if (hasSummary) {
    parts.push("");
    parts.push(`*${summary as string}*`);
  }
  if (hasDesc) {
    parts.push("");
    parts.push(String(desc).trim());
  }

  // Bullet list — one fact per line. Order: type → FK → required/PK → column
  // → default → unique → extends → enum values → validators.
  const bullets: string[] = [];
  bullets.push(`**Type:** ${neutralTypeCell(field)}`);
  if (fk !== undefined) {
    bullets.push(`**References:** [\`${fk.targetEntity}.${fk.targetField}\`](${fk.targetEntity}.md)`);
  }
  if (pkFieldNames.has(field.name)) {
    bullets.push("**Primary key**");
  } else if (isFieldRequired(field)) {
    bullets.push("**Required**");
  }
  if (typeof columnName === "string" && columnName !== field.name) {
    bullets.push(`**Column:** \`${columnName}\``);
  }
  if (typeof dbColumnType === "string" && dbColumnType.length > 0) {
    bullets.push(`**Physical type:** \`${dbColumnType.toUpperCase()}\``);
  }
  if (def !== undefined) {
    bullets.push(`**Default:** \`${String(def)}\``);
  }
  if (isUnique) bullets.push("**Unique**");
  if (sup !== undefined) {
    // The postprocess script rewrites `extends \`Name\`` → enum anchor link.
    bullets.push(`**Extends:** \`${sup.name}\``);
  }
  if (enumVals !== undefined && enumVals.length > 0) {
    const vals = enumVals.map((v) => `\`${v}\``).join(" · ");
    bullets.push(`**Enum values:** ${vals}`);
  }

  // Validators — one bullet per validator subtype (regex / length / numeric),
  // rendered in declaration order so authors can rely on the order they
  // wrote.
  for (const v of validators) {
    if (v.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string" && pattern.length > 0) {
        bullets.push(`**Validator (regex):** pattern \`${pattern}\``);
      }
    } else if (v.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      const fragments: string[] = [];
      if (typeof min === "number") fragments.push(`min ${min}`);
      if (typeof max === "number") fragments.push(`max ${max}`);
      if (fragments.length > 0) bullets.push(`**Validator (length):** ${fragments.join(", ")}`);
    } else if (v.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      const fragments: string[] = [];
      if (typeof min === "number") fragments.push(`min ${min}`);
      if (typeof max === "number") fragments.push(`max ${max}`);
      if (fragments.length > 0) bullets.push(`**Validator (numeric):** ${fragments.join(", ")}`);
    }
  }
  // @maxLength is the shorthand; render alongside validators for consistency.
  if (typeof maxLenAttr === "number") {
    bullets.push(`**Max length:** ${maxLenAttr}`);
  }

  parts.push("");
  for (const b of bullets) parts.push(`- ${b}`);

  return {
    field: field.name,
    block: parts.join("\n"),
  };
}

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

function sourceLine(entity: MetaObject): string | undefined {
  const src = entity.source;
  if (!src) return undefined;
  if ("files" in src && src.files.length > 0) {
    return src.files[0];
  }
  if (src.format === "code") {
    return src.caller !== undefined ? `(code) ${src.caller}` : "(code)";
  }
  return undefined;
}

function entityDescription(entity: MetaObject): string | undefined {
  const v = entity.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function entitySummary(entity: MetaObject): string | undefined {
  const v = entity.attr(DOC_ATTR_SUMMARY);
  return typeof v === "string" && v.length > 0 ? v : undefined;
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
    // The subType discriminator guarantees the instance is a MetaReferenceIdentity;
    // narrow to it so we can use its typed `referencesRaw` getter directly.
    const raw = (id as MetaReferenceIdentity).referencesRaw;
    if (typeof raw === "string" && raw.length > 0) {
      return `**Reference:** ${fieldList} → \`${raw}\``;
    }
    return `**Reference:** ${fieldList}`;
  }
  return `**Identity (${id.subType}):** ${fieldList}`;
}

function relationshipBullet(r: ReturnType<MetaObject["relationships"]>[number]): string {
  const cardinality = r.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
  const card = typeof cardinality === "string" ? cardinality : "?";
  const targetRaw = r.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);
  const target = typeof targetRaw === "string" ? stripPackage(targetRaw) : "?";
  const subtype = r.subType;
  let label: string;
  switch (subtype) {
    case RELATIONSHIP_SUBTYPE_COMPOSITION: label = "composition"; break;
    case RELATIONSHIP_SUBTYPE_AGGREGATION: label = "aggregation"; break;
    case RELATIONSHIP_SUBTYPE_ASSOCIATION: label = "association"; break;
    default: label = subtype;
  }

  // M:N (FR-018): the relationship traverses a junction (`@through`). Describe
  // the edge as related-target THROUGH junction, and mark the self-join shape:
  //   symmetric (undirected) → "symmetric self-join"
  //   @sourceRefField set (directed) → "directed self-join via `<field>`"
  // The junction/disambiguator are DECLARED facts (ADR-0020 — no re-derivation).
  const throughRaw = r.ownAttr(RELATIONSHIP_ATTR_THROUGH);
  if (typeof throughRaw === "string" && throughRaw.length > 0) {
    const through = stripPackage(throughRaw);
    const noteParts = [`${label}, through \`${through}\``];
    if (r.ownAttr(RELATIONSHIP_ATTR_SYMMETRIC) === true) {
      noteParts.push("symmetric self-join");
    } else {
      const srcRef = r.ownAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
      if (typeof srcRef === "string" && srcRef.length > 0) {
        noteParts.push(`directed self-join via \`${srcRef}\``);
      }
    }
    return `\`${r.name}\` — ${card} → \`${target}\` (${noteParts.join(", ")})`;
  }

  return `\`${r.name}\` — ${card} → \`${target}\` (${label})`;
}

/** Build the EntityDocData payload for one entity. The single public-API
 *  entry point exported by this module; the markdown template applies
 *  against this shape. */
export function buildEntityDocData(
  entity: MetaObject,
  opts: BuildDocDataOpts,
): EntityDocData {
  const root = opts.loadedRoot;
  const layout = opts.layout ?? "flat";
  const primary = entity.primaryIdentity();
  const pkFields = primary?.fields ?? [];
  const pkFieldNames = new Set<string>(pkFields);
  const fkMap = buildFkMap(entity, root);

  // ---- Storage rows — NEUTRAL physical persistence MAPPING (ADR-0020): the
  // physical column name, a neutral physical type (declared `@dbColumnType`
  // override else the logical type), nullability, and the key role. NO
  // TypeScript type, NO ORM DDL, NO ANSI re-derivation — declared metadata
  // facts only. The value-add over the Constraints table is the field→column
  // mapping + physical-type override + key role.
  const storageRows: StorageFieldDoc[] = entity.fields().map((field) => {
    const isPk = pkFieldNames.has(field.name);
    // Physical column name: the field's `@column` override if set, else the
    // field name. (The Storage section shows the RAW declared mapping; column
    // naming-strategy folding stays a codegen concern, not a docs fact.)
    const columnName = field.column ?? field.name;
    const columnCell = `\`${columnName}\``;
    const typeCell = storageTypeCell(field);
    // Nullable iff not required and not the PK (matches the Constraints table's
    // required-ness rule).
    const nullable = !(isPk || isFieldRequired(field));
    const nullableCell = nullable ? "yes" : "no";

    let keyCell = "";
    if (isPk) {
      keyCell = "primary key";
    } else {
      const fk = fkMap.get(field.name);
      if (fk !== undefined) keyCell = `foreign key → \`${fk.targetEntity}\``;
    }

    return {
      name: field.name,
      columnCell,
      typeCell,
      nullableCell,
      keyCell,
      rowLine: `| ${columnCell} | ${typeCell} | ${nullableCell} | ${keyCell} |`,
    };
  });

  const isValue = entity.subType === OBJECT_SUBTYPE_VALUE;
  const hasStorage = !isValue && hasWritableRdbSource(entity);

  // ---- Identities
  const ids = entity.identities();
  const identities: IdentityDoc[] | undefined = ids.length > 0
    ? ids.map((id) => ({ bullet: describeIdentity(id) }))
    : undefined;

  // ---- Relationships
  const rels = entity.relationships();
  const relationships: RelationshipDoc[] | undefined = rels.length > 0
    ? rels.map((r) => ({ bullet: relationshipBullet(r) }))
    : undefined;

  // ---- Constraints (NEUTRAL — built from the object's OWN field metadata, so
  // it renders for every object including value objects with no storage).
  // KEPT FOR BACK-COMPAT — new templates render `fields` instead.
  const constraintRows: ConstraintRow[] = entity
    .fields()
    .map((field) => buildConstraintRow(entity, field, pkFieldNames, fkMap));
  const constraints = {
    hasConstraints: constraintRows.length > 0,
    rows: constraintRows,
  };

  // ---- Fields (merged Storage + Constraints) — the single per-field table
  // the new entity-page template renders. Same source of truth as the two
  // legacy tables, just folded into one row.
  const fieldRows: FieldDoc[] = entity
    .fields()
    .map((field) => buildFieldRow(entity, field, pkFieldNames, fkMap));
  const fields = {
    hasFields: fieldRows.length > 0,
    rows: fieldRows,
  };

  // ---- Field details — expanded per-field section, skipping plain fields
  // that the at-a-glance table already covered. The deeper "field details
  // below the table" pattern adopted by Stripe / FHIR / GraphQL — keep the
  // table tight, surface authoring + validation depth below.
  const fieldDetailRows: FieldDetailDoc[] = [];
  for (const field of entity.fields()) {
    const detail = buildFieldDetail(field, pkFieldNames, fkMap);
    if (detail !== undefined) fieldDetailRows.push(detail);
  }
  const fieldDetails = {
    hasDetails: fieldDetailRows.length > 0,
    rows: fieldDetailRows,
  };

  // ---- UsedBy
  const usedByMatches: UsedByDoc[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_TEMPLATE) continue;
    const ref = child.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    if (typeof ref !== "string") continue;
    if (stripPackage(ref) !== entity.name) continue;
    // Link to the template's own doc page. The href is derived from the SAME
    // page-placement function used to write the template page, so it resolves
    // in BOTH layouts (flat → `./<Tmpl>.md`; package → a correct relative path
    // like `../comms/OrderEmail.md`).
    const href = docPageHref(layout, docPageNode(entity), docPageNode(child));
    usedByMatches.push({
      bullet: `[\`template.${child.subType} ${child.name}\`](${href}) — uses \`${entity.name}\` as \`@payloadRef\``,
    });
  }
  const usedBy = usedByMatches.length > 0 ? usedByMatches : undefined;

  // Preamble header — built up exactly as the legacy emitter did.
  const preambleLines: string[] = [];
  const typeStr = `${entity.type}.${entity.subType}`;
  preambleLines.push(`**Type:** \`${typeStr}\``);
  const src = sourceLine(entity);
  if (src !== undefined) preambleLines.push(`**Source:** \`${src}\``);
  if (entity.package !== undefined && entity.package !== "") {
    preambleLines.push(`**Package:** \`${entity.package}\``);
  }
  const preambleHeader = preambleLines.join("\n");

  // Description quote — each line of the description prefixed with "> ".
  const desc = entityDescription(entity);
  let descriptionQuote: string | undefined;
  if (desc !== undefined) {
    descriptionQuote = desc.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  }

  // Summary — short single-line tagline. Rendered as italic lead-in just under
  // the H1, ABOVE @description. Distinct enough that an entity can carry both
  // (description = paragraph; summary = headline).
  const summary = entitySummary(entity);

  const data: EntityDocData = {
    generatedMarker: `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`,
    entity: {
      name: entity.name,
      type: typeStr,
    },
    preambleHeader,
    fields,
    fieldDetails,
    constraints,
  };

  if (desc !== undefined) data.entity.description = desc;
  if (summary !== undefined) {
    data.entity.summary = summary;
    data.summaryLead = `*${summary}*`;
  }
  if (descriptionQuote !== undefined) data.descriptionQuote = descriptionQuote;

  // 1-hop neighborhood diagram — every entity it FKs into + every entity that
  // FKs into it. Rendered just above the Relationships section in the entity
  // page template. Skipped when the entity has zero neighbors (no orphan
  // empty diagram block).
  const neighborhoodErBlock = hasStorage
    ? renderEntityNeighborhoodErBlock(entity, root)
    : undefined;
  if (neighborhoodErBlock !== undefined) {
    data.neighborhoodErBlock = neighborhoodErBlock;
    data.hasNeighborhoodEr = true;
  }
  if (src !== undefined) data.entity.source = src;
  if (entity.package !== undefined && entity.package !== "") {
    data.entity.package = entity.package;
  }

  if (hasStorage) {
    data.storage = {
      tableHeader: "| Column | Type | Nullable | Key |\n|---|---|---|---|",
      rows: storageRows,
    };
    data.hasStorage = true;
  }
  if (identities !== undefined) {
    data.identities = identities;
    data.hasIdentities = true;
  }
  if (relationships !== undefined) {
    data.relationships = relationships;
    data.hasRelationships = true;
  }
  if (usedBy !== undefined) {
    data.usedBy = usedBy;
    data.hasUsedBy = true;
  }
  // Cross-link to the api surfaces — present ONLY when the caller computed the
  // hrefs (api surfaces emitted alongside model); model-only runs stay identical.
  // `last` flags the final ref so the template renders an inline ` · ` separator.
  if (opts.apiRefs !== undefined) {
    data.apiRefs = opts.apiRefs.map((r, i, arr) => ({ ...r, last: i === arr.length - 1 }));
  }

  return data;
}
