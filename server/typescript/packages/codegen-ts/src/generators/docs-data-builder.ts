// Helper that turns a MetaObject (+ root) into the EntityDocData shape the
// templates consume. The previous hand-coded `renderDocsFile()` mixed data
// extraction with string emission; this module is the data-only half — the
// markdown structure now lives in templates/docs/entity-page.md.mustache.

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
import type {
  EntityDocData,
  StorageFieldDoc,
  IdentityDoc,
  RelationshipDoc,
  UsedByDoc,
  GeneratedFileDoc,
} from "./docs-data.js";

export interface BuildDocDataOpts {
  dialect: Dialect;
  columnNamingStrategy?: ColumnNamingStrategy;
  loadedRoot: MetaRoot;
  /** Set of generator names present in the pipeline; drives "Generated code". */
  generatorNames?: ReadonlySet<string>;
}

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

function enumTypeAliasName(entity: MetaObject, field: MetaField): string {
  const superField = field.resolveSuper();
  return superField !== undefined
    ? toPascalCase(superField.name)
    : `${entity.name}${toPascalCase(field.name)}`;
}

function isFieldRequired(field: MetaField): boolean {
  if (field.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
  return field.validators().some((v) => v.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

function tsTypeForStorage(
  entity: MetaObject,
  field: MetaField,
  pkFieldNames: ReadonlySet<string>,
): string {
  let base: string;

  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
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

  const required = pkFieldNames.has(field.name) || isFieldRequired(field);
  return required ? base : `${base} | null`;
}

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

  if (field.subType === FIELD_SUBTYPE_ENUM && !field.isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
      parts.push(`CHECK \`${field.column ?? field.name} IN (${list})\``);
    }
  }

  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string" && pattern.length > 0) {
        parts.push(`pattern \`${pattern}\``);
      }
    }
  }

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

  for (const v of field.validators()) {
    if (v.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const min = v.ownAttr(VALIDATOR_ATTR_MIN);
      const max = v.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") parts.push(`min: ${min}`);
      if (typeof max === "number") parts.push(`max: ${max}`);
    }
  }

  const fk = fkMap.get(field.name);
  if (fk !== undefined) {
    parts.push(`references \`${fk.targetEntity}.${fk.targetField}\``);
  }

  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  if (def !== undefined) {
    parts.push(`default: \`${String(def)}\``);
  }

  const sup = field.resolveSuper();
  if (sup !== undefined) {
    parts.push(`extends \`${sup.name}\``);
  }

  return parts.join(", ");
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
    const refIdent = id as unknown as { referencesRaw?: string };
    const raw = refIdent.referencesRaw;
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
  return `\`${r.name}\` — ${card} → \`${target}\` (${label})`;
}

/** Build the EntityDocData payload for one entity. The single public-API
 *  entry point exported by this module; the markdown template applies
 *  against this shape. */
export function buildEntityDocData(
  entity: MetaObject,
  opts: BuildDocDataOpts,
): EntityDocData {
  const strategy = opts.columnNamingStrategy ?? "snake_case";
  const root = opts.loadedRoot;
  const primary = entity.primaryIdentity();
  const pkFields = primary?.fields ?? [];
  const pkFieldNames = new Set<string>(pkFields);
  const fkMap = buildFkMap(entity, root);

  // ---- Storage rows
  const storageRows: StorageFieldDoc[] = entity.fields().map((field) => {
    const spec = mapColumnType(field, opts.dialect, strategy);
    const tsType = tsTypeForStorage(entity, field, pkFieldNames);
    const tsTypeCell = tsType.split("|").map((s) => s.trim()).join(" \\| ");
    const sqlExpr = sqlColumnExpr(spec);
    const cons = constraintsCell(entity, field, pkFieldNames, fkMap);
    const tsTypeCellStr = `\`${tsTypeCell}\``;
    const sqlExprCellStr = `\`${sqlExpr}\``;
    return {
      name: field.name,
      tsTypeCell: tsTypeCellStr,
      sqlExprCell: sqlExprCellStr,
      constraintsCell: cons,
      rowLine: `| \`${field.name}\` | ${tsTypeCellStr} | ${sqlExprCellStr} | ${cons} |`,
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

  // ---- Validation
  const lower = entity.name.charAt(0).toLowerCase() + entity.name.slice(1);
  const validation = {
    insertSchema: `${entity.name}InsertSchema`,
    updateSchema: `${entity.name}UpdateSchema`,
    entityFile: `${entity.name}.ts`,
    lower,
  };

  // ---- UsedBy
  const usedByMatches: UsedByDoc[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_TEMPLATE) continue;
    const ref = child.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
    if (typeof ref !== "string") continue;
    if (stripPackage(ref) !== entity.name) continue;
    usedByMatches.push({
      bullet: `\`template.${child.subType} ${child.name}\` — uses \`${entity.name}\` as \`@payloadRef\``,
    });
  }
  const usedBy = usedByMatches.length > 0 ? usedByMatches : undefined;

  // ---- Generated
  const gens = opts.generatorNames ?? new Set<string>();
  const generated: GeneratedFileDoc[] = [];
  generated.push({
    filename: `${entity.name}.ts`,
    description: "Drizzle table, Zod schemas, type aliases, enum literal unions.",
  });
  if (gens.has("queries-file") && !isValue) {
    generated.push({
      filename: `${entity.name}.queries.ts`,
      description:
        "typed CRUD helpers (find / list / create / update / delete; takes `db` as first param per ADR-0008).",
    });
  }
  if (gens.has("routes-file") && !isValue) {
    generated.push({
      filename: `${entity.name}.routes.ts`,
      description: `Fastify CRUD-5 route registration (\`register${entity.name}Routes\`).`,
    });
  }
  if (gens.has("routes-file-hono") && !isValue) {
    generated.push({
      filename: `${entity.name}.routes.hono.ts`,
      description: `Hono CRUD-5 route registration (\`register${entity.name}Routes\`).`,
    });
  }

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
    validation,
    generated,
  };

  if (desc !== undefined) data.entity.description = desc;
  if (descriptionQuote !== undefined) data.descriptionQuote = descriptionQuote;
  if (src !== undefined) data.entity.source = src;
  if (entity.package !== undefined && entity.package !== "") {
    data.entity.package = entity.package;
  }

  if (hasStorage) {
    data.storage = {
      tableHeader: "| Field | TypeScript type | SQL column | Constraints |\n|---|---|---|---|",
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
