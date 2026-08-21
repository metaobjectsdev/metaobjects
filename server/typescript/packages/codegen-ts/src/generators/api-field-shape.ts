// api-field-shape.ts — the field SHAPES (name + TS type + optionality) the
// api-docs renderers attach to a unit's model / create-payload / update-payload /
// extractor-payload symbols. ACCURATE BY CONSTRUCTION: every shape REUSES the
// real generators' own field walks so the documented fields can never drift from
// the emitted code (the api-docs accuracy gate enforces the field-set match):
//
//   • model fields      → entity-file's inferred type. The TS type comes from
//     `fieldTsTypeString` (the SINGLE source of truth the value-object interface
//     emitter uses) and the optional/nullable rule from `isFieldRequired` (the
//     SAME rule the docs Storage/Constraints nullable column uses).
//   • create-payload     → `insertSchemaFields` (the EXACT field set + optionality
//     the zod InsertSchema emitter walks: auto-gen PK omitted, @mutability:"readOnly" omitted,
//     TPH discriminator pinned, @autoSet optional, else `fieldWillBeOptional`).
//   • update-payload     → `updateSchemaFields` (the UpdateSchema walk: TPH
//     discriminator + @autoSet-onCreate omitted, everything else optional).
//   • extractor-payload  → the referenced @payloadRef value-object's field
//     interface — the type `extract<Name>` returns — via the SAME
//     `fieldTsTypeString` mapping the VO interface emitter uses.

import type { MetaObject, MetaField, MetaRoot } from "@metaobjectsdev/metadata";
import { fieldTsTypeString } from "../templates/inferred-types.js";
import {
  insertSchemaFields,
  updateSchemaFields,
  type SchemaFieldShape,
} from "../templates/zod-validators.js";
import { isFieldRequired } from "./docs-data-builder.js";

/** One documented field in a model / payload shape. Structured so BOTH renderers
 *  (the human field table + the agent inline shape) format it without re-deriving. */
export interface FieldShape {
  /** The field name (the property key). */
  name: string;
  /** The TS type expression, e.g. `string`, `number`, `"active" | "archived"`,
   *  `Address[]`. Enum unions are inlined (self-contained for an agent). */
  type: string;
  /** Whether the property is optional in this shape (`name?: T`). */
  optional: boolean;
  /** A short note, e.g. `pinned "Bridge"` (TPH discriminator) or `server-set`
   *  (@autoSet). Undefined when there is nothing extra to say. */
  note?: string;
}

/**
 * The entity MODEL field shape — every field, with the value-object interface's
 * TS type and the docs nullable rule (optional iff not required and not the PK).
 * Mirrors `InferSelectModel` field-presence; the PK is reported required.
 */
export function modelFieldShapes(obj: MetaObject): FieldShape[] {
  const pkNames = new Set<string>(obj.primaryIdentity()?.fields ?? []);
  return obj.fields().map((field: MetaField): FieldShape => {
    const isPk = pkNames.has(field.name);
    const required = isPk || isFieldRequired(field);
    return {
      name: field.name,
      type: fieldTsTypeString(obj.name, field),
      optional: !required,
    };
  });
}

/** Resolve a schema-field walk (insert/update) into a documented shape by
 *  pairing each schema field with its TS type (same `fieldTsTypeString` map). A
 *  TPH-pinned discriminator field documents the literal as its type. */
function shapesFromSchemaFields(obj: MetaObject, walk: SchemaFieldShape[]): FieldShape[] {
  const fieldByName = new Map<string, MetaField>(obj.fields().map((f) => [f.name, f]));
  return walk.map((sf): FieldShape => {
    const field = fieldByName.get(sf.name);
    let type = field !== undefined ? fieldTsTypeString(obj.name, field) : "unknown";
    let note: string | undefined;
    if (sf.pinnedLiteral !== undefined) {
      type = JSON.stringify(sf.pinnedLiteral);
      note = `pinned ${type}`;
    } else if (sf.autoSet === true) {
      note = "server-set";
    }
    const shape: FieldShape = { name: sf.name, type, optional: sf.optional };
    if (note !== undefined) shape.note = note;
    return shape;
  });
}

/** The create-payload (InsertSchema) field shape — what `create<Name>` / POST
 *  accepts. */
export function createFieldShapes(obj: MetaObject): FieldShape[] {
  return shapesFromSchemaFields(obj, insertSchemaFields(obj));
}

/** The update-payload (UpdateSchema) field shape — what `update<Name>` / PATCH
 *  accepts (typically all-optional partial). */
export function updateFieldShapes(obj: MetaObject): FieldShape[] {
  return shapesFromSchemaFields(obj, updateSchemaFields(obj));
}

/**
 * The extractor PAYLOAD field shape — the field interface of the value object
 * `extract<Name>` returns (the `@payloadRef` target). Same `fieldTsTypeString`
 * mapping + `isFieldRequired` optionality the VO interface emitter uses, so it
 * matches the emitted payload type. Returns undefined when the ref does not
 * resolve to a loaded object.
 */
export function payloadFieldShapes(root: MetaRoot, payloadRef: string): FieldShape[] | undefined {
  const vo = root.findObject(payloadRef);
  if (vo === undefined) return undefined;
  return modelFieldShapes(vo);
}

/** Format a list of field shapes as a compact inline TS object type, e.g.
 *  `{ name: string; status?: "active" | "archived" }`. Empty list → `{}`. */
export function inlineShape(fields: FieldShape[]): string {
  if (fields.length === 0) return "{}";
  const parts = fields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`);
  return `{ ${parts.join("; ")} }`;
}
