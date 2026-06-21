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
  FIELD_SUBTYPE_ENUM, FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_UUID,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_ARRAY,
  IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  FIELD_ATTR_AUTO_SET, FIELD_ATTR_OBJECT_REF, FIELD_ATTR_READ_ONLY,
  AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE,
  VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_PATTERN,
  GENERATION_INCREMENT, GENERATION_UUID,
  OBJECT_ATTR_DISCRIMINATOR, OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import { enumValues, zodEnumExpr } from "../enum-meta.js";
import { renderDocsFor } from "./jsdoc.js";
import { sharedEnumForField } from "../enum-shared.js";
import { sharedEnumImportSpecifier } from "../enum-import.js";
import { sharedEnumZodConstName } from "./enums-file.js";
import type { RenderContext } from "../render-context.js";
import { valueObjectModuleSpecifier } from "../import-path.js";

/**
 * FR-017 Tier 1 — when this object is a TPH subtype (@discriminatorValue set
 * and an ancestor carries @discriminator), return the discriminator-field-name
 * → pinned-literal-value pair. Subtypes emit `<field>: z.literal("<value>")`
 * instead of the inherited field's normal type expression. Returns undefined
 * when the object is not a TPH subtype.
 */
export function tphDiscriminatorPin(obj: MetaObject): { fieldName: string; value: string } | undefined {
  const value = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
  if (typeof value !== "string" || value === "") return undefined;

  // Walk the extends chain to find the root carrying @discriminator.
  let cursor = obj.superResolved;
  while (cursor !== undefined) {
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

  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";
  return code`
${docsPrefix}export const ${obj.name}Schema = ${z}.object({
${joinCode(fieldLines, { on: ",\n" })}
});
`;
}

/** Auto-generated PK field names that should be omitted from InsertSchema. */
function autoGenPkFieldNames(obj: MetaObject): Set<string> {
  const out = new Set<string>();
  const primary = obj.primaryIdentity();
  if (primary) {
    const generation = primary.ownAttr(IDENTITY_ATTR_GENERATION);
    if (generation === GENERATION_INCREMENT || generation === GENERATION_UUID) {
      const fields = primary.ownAttr(IDENTITY_ATTR_FIELDS);
      const fieldsList = Array.isArray(fields) ? fields : (typeof fields === "string" ? [fields] : []);
      for (const f of fieldsList) out.add(String(f));
    }
  }
  return out;
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
    if (child.ownAttr(FIELD_ATTR_READ_ONLY) === true) continue;

    // FR-017 Tier 1: TPH subtype pins its discriminator field to z.literal(...).
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      insertFieldLines.push(
        code`  ${child.name}: z.literal(${JSON.stringify(tphPin.value)})`,
      );
      continue;
    }

    const autoSet = child.ownAttr(FIELD_ATTR_AUTO_SET);

    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      insertFieldLines.push(code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`);
    }
  }

  const insertSchemaName = `${obj.name}InsertSchema`;
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
    if (child.ownAttr(FIELD_ATTR_READ_ONLY) === true) continue;
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      out.push({ name: child.name, optional: false, pinnedLiteral: tphPin.value });
      continue;
    }
    const autoSet = child.ownAttr(FIELD_ATTR_AUTO_SET);
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
    if (child.ownAttr(FIELD_ATTR_READ_ONLY) === true) continue;
    // TPH subtype discriminator: omitted from the update schema entirely.
    if (tphPin !== undefined && child.name === tphPin.fieldName) continue;
    const autoSet = child.ownAttr(FIELD_ATTR_AUTO_SET);
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
  const tphPin = tphDiscriminatorPin(obj);

  const insertFieldLines: Code[] = [];
  const updateFieldLines: Code[] = [];
  for (const child of obj.fields()) {
    if (autoGenPkFields.has(child.name)) continue;
    // FR-013: @readOnly fields appear in neither InsertSchema nor UpdateSchema.
    // The DB / trigger / replication owns the write path; the app must not
    // pass these values in POST/PATCH bodies (routesFile enforces the same
    // contract at the boundary with a 400 response).
    if (child.ownAttr(FIELD_ATTR_READ_ONLY) === true) continue;

    // FR-017 Tier 1: TPH subtype pins its discriminator field to z.literal(...).
    // The discriminator is implicit on subtype rows (controlled by URL / insert
    // path) — the app never writes it via the body and never updates it.
    // Insert: pinned literal. Update: omitted entirely (clients can't change subtype).
    if (tphPin !== undefined && child.name === tphPin.fieldName) {
      insertFieldLines.push(
        code`  ${child.name}: z.literal(${JSON.stringify(tphPin.value)})`,
      );
      continue;
    }

    const autoSet = child.ownAttr(FIELD_ATTR_AUTO_SET);

    // Insert schema: @autoSet fields use transform (always override client input).
    if (autoSet === AUTO_SET_ON_CREATE || autoSet === AUTO_SET_ON_UPDATE) {
      insertFieldLines.push(
        code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      insertFieldLines.push(code`  ${child.name}: ${zodFieldExpr(child, obj, ctx)}`);
    }

    // Update schema: @autoSet onCreate → omit entirely; onUpdate → transform
    if (autoSet === AUTO_SET_ON_CREATE) {
      // Omit: creation timestamps cannot be changed after creation
    } else if (autoSet === AUTO_SET_ON_UPDATE) {
      updateFieldLines.push(
        code`  ${child.name}: z.string().optional().transform(() => new Date().toISOString())`,
      );
    } else {
      // All non-autoSet fields are optional in the update schema (PATCH semantics).
      // zodFieldExpr already appends .optional() when the field is non-required
      // OR has a default; only append once more when it didn't.
      const baseExpr = zodFieldExpr(child, obj, ctx);
      updateFieldLines.push(
        fieldWillBeOptional(child) ? code`  ${child.name}: ${baseExpr}` : code`  ${child.name}: ${baseExpr}.optional()`,
      );
    }
  }

  const insertSchemaName = `${obj.name}InsertSchema`;
  const updateSchemaName = `${obj.name}UpdateSchema`;

  const docs = renderDocsFor(obj);
  const docsPrefix = docs ? `${docs}\n` : "";

  return code`
${docsPrefix}export const ${insertSchemaName} = ${z}.object({
${joinCode(insertFieldLines, { on: ",\n" })}
});

${docsPrefix}export const ${updateSchemaName} = ${z}.object({
${joinCode(updateFieldLines, { on: ",\n" })}
});
`;
}

function zodFieldExpr(field: MetaField, owner?: MetaObject, ctx?: RenderContext): Code {
  // FIELD_SUBTYPE_OBJECT: emit z.array(<Ref>InsertSchema) / <Ref>InsertSchema
  // via an imp() so ts-poet hoists the cross-module import. Without this the
  // field used to collapse to z.string() / z.array(z.string()) and downstream
  // JSON Schema (e.g. LLM tool_use input_schema) lost the nested object shape.
  if (field.subType === FIELD_SUBTYPE_OBJECT) {
    const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
    if (typeof ref === "string" && ref.length > 0) {
      // @objectRef may be authored fully-qualified or bare — the referenced
      // <Ref>InsertSchema is named by the BARE short name. The import MODULE is
      // resolved via the shared layout/package/extStyle-aware helper (the SAME
      // one the field's TS type + Drizzle .$type<> use) so all three agree.
      // Without owner/ctx (bare unit-test calls) fall back to the flat same-dir.
      const refBase = stripPackage(ref);
      const moduleSpec = (ctx && owner)
        ? valueObjectModuleSpecifier(refBase, ctx.packageOf, owner.package, ctx.outputLayout, ctx.extStyle)
        : `./${refBase}.js`;
      const refImp = imp(`${refBase}InsertSchema@${moduleSpec}`);
      let base: Code = code`${refImp}`;
      if (field.isArray) base = code`z.array(${base})`;
      return appendValidatorChain(base, field);
    }
    // No resolvable @objectRef — fall through to z.unknown(); downstream code
    // can still pass a value through but loses validation.
    let base: Code = code`z.unknown()`;
    if (field.isArray) base = code`z.array(${base})`;
    return appendValidatorChain(base, field);
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
    case FIELD_SUBTYPE_TIMESTAMP:
      baseStr = "z.string()";
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
          if (field.isArray) base = code`z.array(${base})`;
          return appendValidatorChain(base, field);
        }
      }
      baseStr = zodEnumExpr(values);
      break;
    }
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_UUID:
    default:
      baseStr = "z.string()";
      break;
  }

  if (field.isArray) baseStr = `z.array(${baseStr})`;
  return appendValidatorChain(code`${baseStr}`, field);
}

/** Mirrors the optional-or-not decision inside appendValidatorChain so the update-schema
 *  caller can avoid stacking a second `.optional()` onto an already-optional expression. */
function fieldWillBeOptional(field: MetaField): boolean {
  let isRequired = field.ownAttr(FIELD_ATTR_REQUIRED) === true;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) isRequired = true;
  }
  const hasDefault = field.ownAttr(FIELD_ATTR_DEFAULT) !== undefined;
  return !isRequired || hasDefault;
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
  let isRequired = field.ownAttr(FIELD_ATTR_REQUIRED) === true;
  let maxLen: number | undefined = field.ownAttr(FIELD_ATTR_MAX_LENGTH) as number | undefined;
  let minLen: number | undefined;
  let pattern: string | undefined;
  let numMin: number | undefined;
  let numMax: number | undefined;
  let arrMin: number | undefined;
  let arrMax: number | undefined;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) isRequired = true;
    if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      const min = child.ownAttr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") maxLen = max;
      if (typeof min === "number") minLen = min;
    }
    if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const p = child.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof p === "string") pattern = p;
    }
    if (child.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      const min = child.ownAttr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") numMax = max;
      if (typeof min === "number") numMin = min;
    }
    if (child.subType === VALIDATOR_SUBTYPE_ARRAY) {
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      const min = child.ownAttr(VALIDATOR_ATTR_MIN);
      if (typeof max === "number") arrMax = max;
      if (typeof min === "number") arrMin = min;
    }
  }

  let chain: Code = base;
  // Array element-count bounds apply to the z.array(...) wrapper regardless of element type.
  if (field.isArray) {
    if (arrMin !== undefined) chain = code`${chain}.min(${arrMin})`;
    if (arrMax !== undefined) chain = code`${chain}.max(${arrMax})`;
  } else if (field.subType === FIELD_SUBTYPE_STRING) {
    if (minLen !== undefined) chain = code`${chain}.min(${minLen})`;
    else if (isRequired) chain = code`${chain}.min(1)`;
    if (maxLen !== undefined) chain = code`${chain}.max(${maxLen})`;
    if (pattern !== undefined) chain = code`${chain}.regex(new RegExp(${JSON.stringify(pattern)}))`;
  } else if (NUMERIC_FIELD_SUBTYPES.has(field.subType)) {
    if (numMin !== undefined) chain = code`${chain}.min(${numMin})`;
    if (numMax !== undefined) chain = code`${chain}.max(${numMax})`;
  }

  // Fields with DB-level defaults are optional in the InsertSchema: the caller
  // can omit them and the DB will fill in. Otherwise required-with-default
  // would force callers to repeat the default at every call site.
  const hasDefault = field.ownAttr(FIELD_ATTR_DEFAULT) !== undefined;
  if (!isRequired || hasDefault) chain = code`${chain}.optional()`;
  return chain;
}
