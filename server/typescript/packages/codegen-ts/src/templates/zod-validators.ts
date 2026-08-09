// Zod validators template — emits InsertSchema (for create) and UpdateSchema (for update).
// Auto-generated PKs are EXCLUDED from InsertSchema (caller doesn't provide them).
// @autoSet fields: INSERT → .optional().transform(() => new Date().toISOString())
//                 UPDATE → onCreate fields omitted entirely; onUpdate gets same transform
//
// field.object isArray:true objectRef:<Ref> — emits z.array(<Ref>InsertSchema)
// with a cross-module imp() so consumers passing the schema to
// zod-to-json-schema get a properly element-typed array. Without this, every
// object-array field collapsed to z.array(z.string()) and the JSON Schema sent
// downstream (e.g. to LLM tool_use input_schema) lost the nested object shape.

import { code, joinCode, imp, type Code } from "ts-poet";
import { MetaObject, MetaField, stripPackage } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIME, FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_MAP, FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_ARRAY,
  IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION,
  FIELD_ATTR_STRING_FORMAT, FIELD_ATTR_LENIENT, STRING_FORMAT_EMAIL, STRING_FORMAT_HOSTNAME,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  FIELD_ATTR_AUTO_SET, FIELD_ATTR_OBJECT_REF, FIELD_ATTR_VALUE_TYPE, FIELD_ATTR_READ_ONLY,
  FIELD_ATTR_DB_COLUMN_TYPE, DB_COLUMN_TYPE_JSONB,
  AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE,
  VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_PATTERN,
  GENERATION_INCREMENT, GENERATION_UUID,
  OBJECT_ATTR_DISCRIMINATOR, OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import { enumValues, zodEnumExpr } from "../enum-meta.js";
import { ZOD_INET_EXPR } from "./net-regex.js";
import { renderDocsFor } from "./jsdoc.js";
import { sharedEnumForField } from "../enum-shared.js";
import { sharedEnumImportSpecifier } from "../enum-import.js";
import { sharedEnumZodConstName } from "./enums-file.js";
import { fieldDeclaringPackage, type RenderContext } from "../render-context.js";
import { valueObjectModuleSpecifier } from "../import-path.js";
// FR-035: the SAME required-predicate that drives the Drizzle column's .notNull()
// drives the UpdateSchema's .nullable() exclusion — shared so they cannot drift.
import { isRequired } from "../column-mapper.js";

/**
 * FR-017 Tier 1 — when this object is a TPH subtype (@discriminatorValue set
 * and an ancestor carries @discriminator), return the discriminator-field-name
 * → pinned-literal-value pair. Subtypes emit `<field>: z.literal("<value>")`
 * instead of the inherited field's normal type expression. Returns undefined
 * when the object is not a TPH subtype.
 */
export function tphDiscriminatorPin(obj: MetaObject): { fieldName: string; value: string } | undefined {
  // ADR-0039: own — super-resolution walk. A subtype declares its OWN
  // @discriminatorValue (must not inherit one), and the base level is found by
  // walking superResolved reading each level's OWN @discriminator.
  const value = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
  if (typeof value !== "string" || value === "") return undefined;

  // Walk the extends chain to find the root carrying @discriminator.
  let cursor = obj.superResolved;
  while (cursor !== undefined) {
    // ADR-0039: own — super-resolution walk; read each level's OWN @discriminator.
    const fieldName = cursor.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
    if (typeof fieldName === "string" && fieldName !== "") {
      return { fieldName, value };
    }
    cursor = cursor.superResolved;
  }
  return undefined;
}

/** True when this object is a TPH subtype — it declares @discriminatorValue
 *  and an ancestor carries @discriminator. */
export function isTphSubtype(obj: MetaObject): boolean {
  return tphDiscriminatorPin(obj) !== undefined;
}

/** True when this object declares at least one @autoSet timestamp field
 *  (onCreate or onUpdate). Drives whether codegen emits the #203
 *  `<Entity>InsertPreservingSchema` + `insertPreserving<Entity>` escape hatch —
 *  a plain entity has nothing to preserve, so both are omitted. Resolving
 *  (ADR-0039): honors an @autoSet inherited via extends. */
export function hasAutoSetFields(obj: MetaObject): boolean {
  for (const child of obj.fields()) {
    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) return true;
  }
  return false;
}

/**
 * FR-017 Tier 2 — the per-subtype FULL read schema `<Sub>Schema`. Unlike the
 * insert schema, this includes every effective field (PK included) so a raw DB
 * row parses through it. The discriminator field is pinned to its literal value
 * (`type: z.literal("Bridge")`) so the schema rejects a row of another subtype.
 *
 * This is the schema parse<Base>(row) dispatches to (see tph-discriminator.ts).
 * Non-required columns are `.nullable()`-tolerant: a nullable TPH column read
 * back from the DB arrives as `null`, not `undefined`, so the read schema must
 * accept null (the insert schema, by contrast, makes them `.optional()`).
 */
export function renderTphSubtypeReadSchema(obj: MetaObject, ctx?: RenderContext): Code {
  const z = imp("z@zod");
  const tphPin = tphDiscriminatorPin(obj);

  const fieldLines: Code[] = [];
  for (const child of obj.fields()) {
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      fieldLines.push(code`  ${child.name}: z.literal(${JSON.stringify(tphPin.value)})`);
      continue;
    }
    const expr = zodFieldExpr(child, obj, ctx);
    // zodFieldExpr already appends `.optional()` for non-required fields; add
    // `.nullable()` on top so a NULL column value (the TPH default for any
    // subtype-only column) parses cleanly.
    fieldLines.push(
      fieldWillBeOptional(child) ? code`  ${child.name}: ${expr}.nullable()` : code`  ${child.name}: ${expr}`,
    );
  }

  const objName = ctx ? ctx.valueObjectEmittedName(obj) : obj.name;
  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";
  return code`
${docsPrefix}export const ${objName}Schema = ${z}.object({
${joinCode(fieldLines, { on: ",\n" })}
});
`;
}

/** Field names participating in the object's PRIMARY identity, normalized to a
 *  list. Empty when the object has no primary identity. */
function primaryIdentityFieldNames(obj: MetaObject): string[] {
  const primary = obj.primaryIdentity();
  if (!primary) return [];
  const fields = primary.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(fields)) return fields.map(String);
  if (typeof fields === "string") return [fields];
  return [];
}

/** Auto-generated PK field names that should be omitted from InsertSchema. */
function autoGenPkFieldNames(obj: MetaObject): Set<string> {
  const generation = obj.primaryIdentity()?.attr(IDENTITY_ATTR_GENERATION);
  if (generation !== GENERATION_INCREMENT && generation !== GENERATION_UUID) return new Set();
  return new Set(primaryIdentityFieldNames(obj));
}

/** ALL field names participating in the object's PRIMARY identity, regardless of
 *  @generation. A PK column is never NULL (single-col via Drizzle `.primaryKey()`,
 *  composite via `.notNull()`), so FR-035 PATCH-2 must NOT make a PK field
 *  `.nullable()` in the UpdateSchema even when it carries no @required — otherwise
 *  an explicit null typechecks into Drizzle's `.set()` (which rejects null on a
 *  not-null column) and would violate NOT NULL at runtime. Unlike
 *  autoGenPkFieldNames (which only lists increment/uuid PKs, already excluded from
 *  the schema), this covers assigned + extended-identity projection PKs too. */
function primaryKeyFieldNames(obj: MetaObject): Set<string> {
  return new Set(primaryIdentityFieldNames(obj));
}

/**
 * Emit ONLY the `<Name>InsertSchema`. Used by the value-object file emitter
 * for metaobjects with no writable source.rdb — those have no PATCH/update
 * semantics, so emitting an UpdateSchema would be misleading.
 *
 * The schema name is kept as `<Name>InsertSchema` even for pure value objects
 * so consumer imports don't churn. A future polish PR could add a `<Name>Schema`
 * alias for clarity.
 */
export function renderInsertSchemaOnly(obj: MetaObject, ctx?: RenderContext): Code {
  const z = imp("z@zod");
  const autoGenPkFields = autoGenPkFieldNames(obj);
  const tphPin = tphDiscriminatorPin(obj);

  const insertFieldLines: Code[] = [];
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;
    // FR-013: @readOnly fields are populated by DB / replication / external
    // owner; the application has no path to write them. Exclude from the
    // create-shape schema entirely.
    // #213 — a derived (origin-bearing) field is read-only (FR-024 §7 / ADR-0028):
    // excluded from the Insert/Update/preserving schemas, exactly like @readOnly.
    if (child.attr(FIELD_ATTR_READ_ONLY) === true || child.isDerived()) continue;

    // FR-017 Tier 1: TPH subtype pins its discriminator field to z.literal(...).
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      insertFieldLines.push(
        code`  ${child.name}: z.literal(${JSON.stringify(tphPin.value)})`,
      );
      continue;
    }

    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);

    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        ctx?.timestampMode === "date"
          ? code`  ${child.name}: z.date().optional().transform(() => new Date())`
          : code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      insertFieldLines.push(code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`);
    }
  }

  // ADR-0044/#228 — the schema name follows the value object's EMITTED name
  // (bare when unique in the run, package-qualified on a cross-package short-name
  // collision) so importers (entity/extract tiers) resolve the same symbol.
  const objName = ctx ? ctx.valueObjectEmittedName(obj) : obj.name;
  const insertSchemaName = `${objName}InsertSchema`;
  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";

  return code`
${docsPrefix}export const ${insertSchemaName} = ${z}.object({
${joinCode(insertFieldLines, { on: ",\n" })}
});
`;
}

/** One documented field in an Insert/Update schema's accepted shape. */
export interface SchemaFieldShape {
  /** The field name (the schema property key). */
  name: string;
  /** Whether the property is optional in the schema (`.optional()` / omitted-OK). */
  optional: boolean;
  /** For the @discriminator field on a TPH subtype's InsertSchema: the pinned
   *  literal value (`z.literal("Bridge")`). Undefined otherwise. */
  pinnedLiteral?: string;
  /** True for @autoSet timestamp fields the schema fills server-side
   *  (`z.string().optional().transform(...)`). */
  autoSet?: boolean;
}

/**
 * The field SET (name + optionality) the `<Name>InsertSchema` accepts — derived
 * by the SAME iteration + skip rules `renderInsertSchemaOnly` /
 * `renderZodValidators` use to EMIT that schema, so a documented create-payload
 * shape can never drift from the real schema:
 *   • auto-generated PK fields are omitted (caller doesn't provide them);
 *   • @readOnly fields are omitted (DB / replication owns the write path);
 *   • a TPH subtype's @discriminator field is a pinned `z.literal(value)`;
 *   • @autoSet fields are present but optional (server fills them);
 *   • every other field's optionality is `fieldWillBeOptional` (not required, or
 *     carries a @default).
 */
export function insertSchemaFields(obj: MetaObject): SchemaFieldShape[] {
  const autoGenPkFields = autoGenPkFieldNames(obj);
  const tphPin = tphDiscriminatorPin(obj);
  const out: SchemaFieldShape[] = [];
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;
    // #213 — a derived (origin-bearing) field is read-only (FR-024 §7 / ADR-0028):
    // excluded from the Insert/Update/preserving schemas, exactly like @readOnly.
    if (child.attr(FIELD_ATTR_READ_ONLY) === true || child.isDerived()) continue;
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      out.push({ name: child.name, optional: false, pinnedLiteral: tphPin.value });
      continue;
    }
    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      out.push({ name: child.name, optional: true, autoSet: true });
    } else {
      out.push({ name: child.name, optional: fieldWillBeOptional(child) });
    }
  }
  return out;
}

/**
 * The field SET the `<Name>UpdateSchema` accepts — same iteration + skip rules
 * as `insertSchemaFields`, but mirroring the UpdateSchema branch of
 * `renderZodValidators`:
 *   • a TPH subtype's @discriminator field is OMITTED (clients can't change subtype);
 *   • @autoSet onCreate fields are OMITTED (creation timestamps are immutable);
 *   • @autoSet onUpdate fields are present + optional (server fills them);
 *   • every other field is optional (PATCH semantics).
 */
export function updateSchemaFields(obj: MetaObject): SchemaFieldShape[] {
  const autoGenPkFields = autoGenPkFieldNames(obj);
  const tphPin = tphDiscriminatorPin(obj);
  const out: SchemaFieldShape[] = [];
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;
    // #213 — a derived (origin-bearing) field is read-only (FR-024 §7 / ADR-0028):
    // excluded from the Insert/Update/preserving schemas, exactly like @readOnly.
    if (child.attr(FIELD_ATTR_READ_ONLY) === true || child.isDerived()) continue;
    // TPH subtype discriminator: omitted from the update schema entirely.
    if (tphPin !== undefined && child.name === tphPin.fieldName) continue;
    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);
    if (autoSet === AUTO_SET_ON_CREATE) {
      // Omitted: creation timestamps cannot change after creation.
      continue;
    }
    if (autoSet === AUTO_SET_ON_UPDATE) {
      out.push({ name: child.name, optional: true, autoSet: true });
      continue;
    }
    // All non-autoSet fields are optional in the update schema (PATCH semantics).
    out.push({ name: child.name, optional: true });
  }
  return out;
}

export function renderZodValidators(obj: MetaObject, ctx?: RenderContext): Code {
  const z = imp("z@zod");
  const autoGenPkFields = autoGenPkFieldNames(obj);
  const pkFields = primaryKeyFieldNames(obj);
  const tphPin = tphDiscriminatorPin(obj);

  const insertFieldLines: Code[] = [];
  const updateFieldLines: Code[] = [];
  // #203 — the `insertPreserving` escape hatch's schema: same shape as the insert
  // schema, but @autoSet columns are written VERBATIM (no create-time now()
  // transform). Only emitted when the entity declares @autoSet fields.
  const preservingFieldLines: Code[] = [];
  const emitPreserving = hasAutoSetFields(obj);
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;
    // FR-013: @readOnly fields appear in neither InsertSchema nor UpdateSchema.
    // The DB / trigger / replication owns the write path; the app must not
    // pass these values in POST/PATCH bodies (routesFile enforces the same
    // contract at the boundary with a 400 response).
    // #213 — a derived (origin-bearing) field is read-only (FR-024 §7 / ADR-0028):
    // excluded from the Insert/Update/preserving schemas, exactly like @readOnly.
    if (child.attr(FIELD_ATTR_READ_ONLY) === true || child.isDerived()) continue;

    // FR-017 Tier 1: TPH subtype pins its discriminator field to z.literal(...).
    // The discriminator is implicit on subtype rows (controlled by URL / insert
    // path) — the app never writes it via the body and never updates it.
    // Insert: pinned literal. Update: omitted entirely (clients can't change subtype).
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      const litLine = code`  ${child.name}: z.literal(${JSON.stringify(tphPin.value)})`;
      insertFieldLines.push(litLine);
      preservingFieldLines.push(litLine);
      continue;
    }

    const autoSet = child.attr(FIELD_ATTR_AUTO_SET);

    // Insert schema: @autoSet fields use transform (always override client input).
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        ctx?.timestampMode === "date"
          ? code`  ${child.name}: z.date().optional().transform(() => new Date())`
          : code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
      // Preserving schema: the @autoSet column is validated verbatim (its natural
      // field expr) so an import/restore keeps the caller's original timestamp.
      preservingFieldLines.push(code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`);
    } else {
      const fieldLine = code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`;
      insertFieldLines.push(fieldLine);
      preservingFieldLines.push(fieldLine);
    }

    // Update schema: @autoSet onCreate → omit entirely; onUpdate → transform
    if (autoSet === AUTO_SET_ON_CREATE) {
      // Omit: creation timestamps cannot be changed after creation
    } else if (autoSet === AUTO_SET_ON_UPDATE) {
      updateFieldLines.push(
        ctx?.timestampMode === "date"
          ? code`  ${child.name}: z.date().optional().transform(() => new Date())`
          : code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      // All non-autoSet fields are optional in the update schema (PATCH semantics).
      // zodFieldExpr already appends .optional() when the field is non-required
      // OR has a default; only append once more when it didn't.
      const baseExpr = zodFieldExpr(child, obj, ctx);
      let expr = fieldWillBeOptional(child) ? baseExpr : code`${baseExpr}.optional()`;
      // FR-035 PATCH-2: a NON-@required field additionally accepts an explicit
      // null — a present null CLEARS the column (`.set({field: null})` writes NULL).
      // Keyed on required-ness, NOT fieldWillBeOptional: a required-with-@default
      // field stays non-nullable so an explicit null on it is a 400 (validation),
      // never a silent clear. PK fields are excluded: their Drizzle column is
      // always not-null, so a nullable Zod type would fail `.set()`'s typecheck
      // (and NOT NULL at runtime) — see primaryKeyFieldNames.
      if (!isRequired(child) && !pkFields.has(child.name)) expr = code`${expr}.nullable()`;
      updateFieldLines.push(code`  ${child.name}: ${expr}`);
    }
  }

  // ADR-0044/#228 — schema + type-alias names follow the object's EMITTED name.
  // For entities (never in the value-object collision set) and non-colliding value
  // objects this equals `obj.name` (byte-identical).
  const objName = ctx ? ctx.valueObjectEmittedName(obj) : obj.name;
  const insertSchemaName = `${objName}InsertSchema`;
  const updateSchemaName = `${objName}UpdateSchema`;
  const preservingSchemaName = `${objName}InsertPreservingSchema`;

  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";

  // #203 — emit the preserving insert-shape only for @autoSet entities (nothing to
  // preserve otherwise). Backs `insertPreserving<Entity>` (import/restore/replication).
  const preservingBlock = emitPreserving
    ? code`

/** Insert-shape for import / restore / replication of ${objName}: identical to
 * ${insertSchemaName}, but the @autoSet timestamp columns are written VERBATIM
 * (no create-time now() stamp) so the caller's original values are preserved. */
export const ${preservingSchemaName} = ${z}.object({
${joinCode(preservingFieldLines, { on: ",\n" })}
});`
    : code``;

  return code`
${docsPrefix}export const ${insertSchemaName} = ${z}.object({
${joinCode(insertFieldLines, { on: ",\n" })}
});

${docsPrefix}export const ${updateSchemaName} = ${z}.object({
${joinCode(updateFieldLines, { on: ",\n" })}
});

/** Typed patch shape for ${objName}: every settable field, optional (FR-035 PATCH). A
 * renamed/dropped field is a compile error at every \`update${objName}\` call site. */
export type ${objName}Patch = ${z}.input<typeof ${updateSchemaName}>;${preservingBlock}
`;
}

/**
 * ADR-0036/0037 Wave 3 — the CANONICAL hostname matcher for @stringFormat:
 * hostname, emitted as a Zod `.regex(...)` literal. The matcher lives in codegen
 * (NOT author validator.regex) so every port can replicate the SAME canonical
 * form — cross-language regex engines diverge, so the byte-identical source of
 * truth is this one expression. RFC 1123 labels: 1–63 chars each, alphanumeric
 * + internal hyphens, dot-separated; total form anchored.
 */
const HOSTNAME_REGEX_LITERAL =
  "/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/";

/** Zod expression for a scalar value subtype (used for a field.map's @valueType). */
function zodScalarFor(subType: string): string {
  if (subType === FIELD_SUBTYPE_INT || subType === FIELD_SUBTYPE_LONG || subType === FIELD_SUBTYPE_CURRENCY) return "z.number().int()";
  if (subType === FIELD_SUBTYPE_DOUBLE || subType === FIELD_SUBTYPE_FLOAT) return "z.number()";
  if (subType === FIELD_SUBTYPE_BOOLEAN) return "z.boolean()";
  return "z.string()"; // string/uuid/date/time/timestamp/decimal/enum on the wire
}

function zodFieldExpr(field: MetaField, owner?: MetaObject, ctx?: RenderContext): Code {
  // `@dbColumnType: jsonb` on a scalar (legal only on field.string) is the
  // sanctioned "open JSON bag" escape hatch — a genuinely untyped JSON column
  // with no value-object to reference. Its Drizzle column is a bare `jsonb()`,
  // which node-postgres returns as a PARSED JS value (object/array/scalar), not
  // a string. Emitting `z.string()` here would 400-reject the real value on
  // insert and fail the same schema on read-back, contradicting the column type
  // AND the native-object runtime-return contract (ADR-0019). Emit `z.unknown()`
  // (jsonb holds any JSON value — same treatment as an objectRef-less
  // field.object below).
  if (field.attr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB) {
    let base: Code = code`z.unknown()`;
    if (field.resolvedIsArray()) base = code`z.array(${base})`;
    return appendValidatorChain(base, field);
  }

  // FIELD_SUBTYPE_OBJECT: emit z.array(<Ref>InsertSchema) / <Ref>InsertSchema
  // via an imp() so ts-poet hoists the cross-module import. Without this the
  // field used to collapse to z.string() / z.array(z.string()) and downstream
  // JSON Schema (e.g. LLM tool_use input_schema) lost the nested object shape.
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      // @objectRef may be authored fully-qualified or bare. ADR-0044/#228 — the
      // referenced <Ref>InsertSchema is named by the value object's EMITTED name
      // (bare when unique in the run, package-qualified on a cross-package
      // short-name collision), resolved package-locally from the FIELD's declaring
      // package. The import MODULE is resolved via the shared
      // layout/package/extStyle-aware helper (the SAME one the field's TS type +
      // Drizzle .$type<> use) so all three agree. Without owner/ctx (bare
      // unit-test calls) fall back to the bare name + flat same-dir.
      const refName = (ctx && owner) ? ctx.resolveValueObjectName(ref, fieldDeclaringPackage(field, owner.package)) : stripPackage(ref);
      const moduleSpec = (ctx && owner)
        ? valueObjectModuleSpecifier(refName, ctx.packageOf, owner.package, ctx.outputLayout, ctx.extStyle)
        : `./${refName}.js`;
      const refImp = imp(`${refName}InsertSchema@${moduleSpec}`);
      let base: Code = code`${refImp}`;
      if (field.resolvedIsArray()) base = code`z.array(${base})`;
      return appendValidatorChain(base, field);
    }
    // No resolvable @objectRef — fall through to z.unknown(); downstream code
    // can still pass a value through but loses validation.
    let base: Code = code`z.unknown()`;
    if (field.resolvedIsArray()) base = code`z.array(${base})`;
    return appendValidatorChain(base, field);
  }

  // field.map → z.record(z.string(), V): value is a VO's InsertSchema (@objectRef)
  // or a scalar zod (@valueType). Keys are always strings.
  if (field.subType === FIELD_SUBTYPE_MAP) {
    const ref = field.attr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      const refName = (ctx && owner) ? ctx.resolveValueObjectName(ref, fieldDeclaringPackage(field, owner.package)) : stripPackage(ref);
      const moduleSpec = (ctx && owner)
        ? valueObjectModuleSpecifier(refName, ctx.packageOf, owner.package, ctx.outputLayout, ctx.extStyle)
        : `./${refName}.js`;
      const refImp = imp(`${refName}InsertSchema@${moduleSpec}`);
      return appendValidatorChain(code`z.record(z.string(), ${refImp})`, field);
    }
    const vt = field.attr(FIELD_ATTR_VALUE_TYPE);
    return appendValidatorChain(code`z.record(z.string(), ${zodScalarFor(typeof vt === "string" ? vt : "string")})`, field);
  }

  let baseStr: string;
  switch (field.subType) {
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_CURRENCY:
    case FIELD_SUBTYPE_LONG:
      baseStr = "z.number().int()";
      break;
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      baseStr = "z.number()";
      break;
    case FIELD_SUBTYPE_BOOLEAN:
      baseStr = "z.boolean()";
      break;
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
      baseStr = "z.string()"; // calendar date / time-of-day — always ISO-string-shaped, not governed by timestampMode
      break;
    case FIELD_SUBTYPE_TIMESTAMP:
      // Must agree with column-mapper.ts's mapColumnType, which already honors
      // ctx.timestampMode for the Drizzle column itself — z.string() here regardless would
      // disagree with a "date"-mode column (Date-typed) and fail to typecheck downstream
      // (reported against an adopting project).
      baseStr = ctx?.timestampMode === "date" ? "z.date()" : "z.string()";
      break;
    case FIELD_SUBTYPE_ENUM: {
      const values = enumValues(field);
      if (values === undefined) {
        baseStr = "z.string()";
        break;
      }
      // FR-019: a field extending a MATERIALIZED root-level abstract enum uses the
      // shared `<E>Enum` Zod const (imported from ./enums) instead of inlining
      // z.enum([...]). A @provided enum keeps inline z.enum([...]) — validation
      // stays metaobjects-owned (the @values SSOT); only the TS type is external.
      // Inline enums (and bare-ctx unit-test calls) keep inlining as before.
      if (ctx !== undefined) {
        const shared = sharedEnumForField(field);
        if (shared !== undefined && !shared.provided) {
          const constName = sharedEnumZodConstName(shared.name);
          const spec = sharedEnumImportSpecifier(ctx, owner?.package);
          const sharedConst = imp(`${constName}@${spec}`);
          let base: Code = code`${sharedConst}`;
          if (field.resolvedIsArray()) base = code`z.array(${base})`;
          return appendValidatorChain(base, field);
        }
      }
      baseStr = zodEnumExpr(values);
      break;
    }
    case FIELD_SUBTYPE_URI:
      // ADR-0036/0037 Wave 3: a URI/URL string — codegen owns the canonical
      // URL matcher (Zod .url()), never author regex. #234: @lenient opts out
      // of well-formedness — bind a plain string.
      baseStr = field.attr(FIELD_ATTR_LENIENT) === true ? "z.string()" : "z.string().url()";
      break;
    case FIELD_SUBTYPE_INET:
      // ADR-0036/0037 Wave 3 + #234: an IP-address string (v4 or v6 literal) —
      // codegen owns the canonical IP matcher. Zod-version-agnostic regex union
      // (Zod 4 removed `z.string().ip()`); see net-regex.ts. @lenient → a plain string.
      baseStr = field.attr(FIELD_ATTR_LENIENT) === true ? "z.string()" : ZOD_INET_EXPR;
      break;
    case FIELD_SUBTYPE_STRING: {
      // ADR-0036/0037 Wave 3: @stringFormat narrows a plain string to a closed
      // validated format. The canonical matcher per format lives HERE (codegen),
      // not author validator.regex. The field stays a plain string.
      const fmt = field.attr(FIELD_ATTR_STRING_FORMAT);
      if (fmt === STRING_FORMAT_EMAIL) {
        baseStr = "z.string().email()";
      } else if (fmt === STRING_FORMAT_HOSTNAME) {
        baseStr = `z.string().regex(${HOSTNAME_REGEX_LITERAL})`;
      } else {
        baseStr = "z.string()";
      }
      break;
    }
    case FIELD_SUBTYPE_UUID:
    default:
      baseStr = "z.string()";
      break;
  }

  if (field.resolvedIsArray()) baseStr = `z.array(${baseStr})`;
  return appendValidatorChain(code`${baseStr}`, field);
}

/** Mirrors the optional-or-not decision inside appendValidatorChain so the update-schema
 *  caller can avoid stacking a second `.optional()` onto an already-optional expression. */
function fieldWillBeOptional(field: MetaField): boolean {
  const hasDefault = field.attr(FIELD_ATTR_DEFAULT) !== undefined;
  return !isRequired(field) || hasDefault;
}

/** Numeric field subtypes whose Zod base is `z.number()` — value bounds apply. */
const NUMERIC_FIELD_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
]);

/** Append .min/.max/.regex/.optional() based on field-level validators + required state.
 *
 * Bound semantics by field shape:
 *  - string (scalar)        → .min/.max = character count (validator.length + @maxLength)
 *  - numeric (scalar)       → .min/.max = numeric value     (validator.numeric)
 *  - array (any element)    → .min/.max = element count     (validator.array)
 */
function appendValidatorChain(base: Code, field: MetaField): Code {
  let isRequired = field.attr(FIELD_ATTR_REQUIRED) === true;
  let maxLen: number | undefined = field.attr(FIELD_ATTR_MAX_LENGTH) as number | undefined;
  let minLen: number | undefined;
  let pattern: string | undefined;
  let numMin: number | undefined;
  let numMax: number | undefined;
  let arrMin: number | undefined;
  let arrMax: number | undefined;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) isRequired = true;
    // ADR-0039: resolving — a validator may inherit @min/@max/@pattern via extends
    // (matches Java attrInt's resolving getMetaAttr(attr)).
    if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const max = child.attr(VALIDATOR_ATTR_MAX);
      const min = child.attr(VALIDATOR_ATTR_MIN);
      // FR-036 A3: @maxLength × validator.length @max = strictest-wins (min).
      // maxLen already carries the field-level @maxLength; fold the validator's
      // @max in as a lower bound so the effective cap is min(@maxLength, @max).
      if (typeof max === "number") maxLen = maxLen === undefined ? max : Math.min(maxLen, max);
      if (typeof min === "number") minLen = min;
    }
    if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const p = child.attr(VALIDATOR_ATTR_PATTERN);
      if (typeof p === "string") pattern = p;
    }
    if (child.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const max = child.attr(VALIDATOR_ATTR_MAX);
      const min = child.attr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") numMax = max;
      if (typeof min === "number") numMin = min;
    }
    if (child.subType === VALIDATOR_SUBTYPE_ARRAY) {
      const max = child.attr(VALIDATOR_ATTR_MAX);
      const min = child.attr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") arrMax = max;
      if (typeof min === "number") arrMin = min;
    }
  }

  // A `field.string` + `@dbColumnType: jsonb` open bag has a `z.unknown()` base, so
  // the string character-count validators (.min/.max/.regex) do NOT apply — chaining
  // `.min(1)` for a required bag yields `z.unknown().min(1)`, a TS compile error.
  // "Required" for an open bag means non-optional only (handled by the optional()
  // logic below). A jsonb ARRAY still gets element-count bounds via the array branch.
  const isJsonbBag = field.attr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB;

  let chain: Code = base;
  // Array element-count bounds apply to the z.array(...) wrapper regardless of element type.
  if (field.resolvedIsArray()) {
    if (arrMin !== undefined) chain = code`${chain}.min(${arrMin})`;
    if (arrMax !== undefined) chain = code`${chain}.max(${arrMax})`;
  } else if (field.subType === FIELD_SUBTYPE_STRING && !isJsonbBag) {
    // FR-036 Pin 1: a @required string is non-empty by default (implicit floor of
    // 1) — but an explicitly authored `validator.length @min` is ALWAYS
    // authoritative over that floor (#224 / ADR-0044): `@min: 0` opts back to
    // presence-only, restoring "must be provided, may be empty". The floor
    // applies only when no @min was authored at all. A non-required field keeps
    // its authored @min unchanged (undefined -> 0, i.e. no minimum).
    const effectiveMin = minLen !== undefined ? minLen : isRequired ? 1 : 0;
    if (effectiveMin > 0) chain = code`${chain}.min(${effectiveMin})`;
    if (maxLen !== undefined) chain = code`${chain}.max(${maxLen})`;
    if (pattern !== undefined) {
      // FR-036 Pin 2: validator.regex @pattern is FULL-MATCH — the whole value
      // must match. JS RegExp.test searches, so anchor as ^(?:…)$ (always-wrap;
      // a redundant anchor on an already-anchored pattern still matches identically).
      const anchored = `^(?:${pattern})$`;
      chain = code`${chain}.regex(new RegExp(${JSON.stringify(anchored)}))`;
    }
  } else if (NUMERIC_FIELD_SUBTYPES.has(field.subType)) {
    if (numMin !== undefined) chain = code`${chain}.min(${numMin})`;
    if (numMax !== undefined) chain = code`${chain}.max(${numMax})`;
  }

  // Fields with DB-level defaults are optional in the InsertSchema: the caller
  // can omit them and the DB will fill in. Otherwise required-with-default
  // would force callers to repeat the default at every call site.
  const hasDefault = field.attr(FIELD_ATTR_DEFAULT) !== undefined;
  if (!isRequired || hasDefault) chain = code`${chain}.optional()`;
  return chain;
}
