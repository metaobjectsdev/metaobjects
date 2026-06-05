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
  FIELD_ATTR_DB_COLUMN_TYPE,
  stripPackage,
} from "@metaobjectsdev/metadata";
import type { Dialect } from "../column-mapper.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import type { OutputLayout } from "../import-path.js";
import { docPageHref, docPageNode } from "../docs-paths.js";
import { enumValues } from "../enum-meta.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { GENERATED_HEADER } from "../constants.js";
import type {
  EntityDocData,
  StorageFieldDoc,
  IdentityDoc,
  RelationshipDoc,
  UsedByDoc,
  ConstraintRow,
} from "./docs-data.js";

export interface BuildDocDataOpts {
  dialect: Dialect;
  columnNamingStrategy?: ColumnNamingStrategy;
  loadedRoot: MetaRoot;
  /** Page-placement layout. Defaults to "flat" (back-compat: same-dir links). */
  layout?: OutputLayout;
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
function neutralTypeStr(field: MetaField): string {
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
    field: `\`${field.name}\``,
    required: required ? "yes" : "",
    type: neutralTypeCell(field),
    limits: limits.join(", "),
    rules: rules.join(", "),
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
  const constraintRows: ConstraintRow[] = entity
    .fields()
    .map((field) => buildConstraintRow(entity, field, pkFieldNames, fkMap));
  const constraints = {
    hasConstraints: constraintRows.length > 0,
    rows: constraintRows,
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

  const data: EntityDocData = {
    generatedMarker: `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`,
    entity: {
      name: entity.name,
      type: typeStr,
    },
    preambleHeader,
    constraints,
  };

  if (desc !== undefined) data.entity.description = desc;
  if (descriptionQuote !== undefined) data.descriptionQuote = descriptionQuote;
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

  return data;
}
