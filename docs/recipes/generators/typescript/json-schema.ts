// EXAMPLE GENERATOR — copy it into your repo (codegen/generators/json-schema.ts) and own it.
// It is a worked example, NOT a supported MetaObjects product surface: no release promises
// its output, and when you need a different shape you edit your copy.
//
// Wire it in metaobjects.config.ts:
//   import { jsonSchemaFile } from "./codegen/generators/json-schema.js";
//   export default defineConfig({ generators: [jsonSchemaFile()] });
//
// emits:  <outDir>/schemas/<package path>/<Name>.schema.json — one JSON Schema (draft
//         2020-12) per concrete object in the model (entities, value objects, projections).
//         `meta verify --codegen` re-runs it and fails when a committed schema is stale.
//
// The three things every generator gets right, all visible below:
//   1. WHICH objects — `ctx.entities` is every object in the model, abstract bases
//      included, so filter with `isAbstract` (or another exported predicate).
//   2. RESOLVING accessors (ADR-0039) — `fields()`, `attr()`, `isRequired`, `maxLength`,
//      `resolvedIsArray()` all see what a field inherits through `extends`. The `own*()`
//      forms and the raw `isArray` flag do not; do not use them here.
//   3. Names from the model — the object's own `name`, its package via `effectivePackage`,
//      and `@objectRef` resolved with `objectRefTarget` (package-aware, never a bare
//      string match).
import {
  effectivePackage,
  enumValues,
  isAbstract,
  objectRefTarget,
  packageToPath,
  perEntity,
  type Generator,
} from "@metaobjectsdev/codegen-ts";
import type { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  DOC_ATTR_DESCRIPTION,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INET,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_UUID,
} from "@metaobjectsdev/metadata/constants";

export type JsonSchema = { [key: string]: unknown };

export interface JsonSchemaFileOpts {
  /** Narrow which objects get a schema (ANDed with "not abstract"). */
  filter?: (entity: MetaObject) => boolean;
  /** Named output target, as on every generator. */
  target?: string;
}

/** Where an object's schema lands, relative to the target's outDir. */
export function schemaPath(obj: MetaObject): string {
  const pkg = effectivePackage(obj);
  const dir = pkg === undefined ? "schemas" : `schemas/${packageToPath(pkg)}`;
  return `${dir}/${obj.name}.schema.json`;
}

/** Relative `$ref` from one object's schema file to another's. */
function relativeRef(from: MetaObject, to: MetaObject): string {
  const fromDir = schemaPath(from).split("/").slice(0, -1);
  const toParts = schemaPath(to).split("/");
  let i = 0;
  while (i < fromDir.length && fromDir[i] === toParts[i]) i++;
  const up = fromDir.slice(i).map(() => "..");
  const rel = [...up, ...toParts.slice(i)].join("/");
  return up.length === 0 ? `./${rel}` : rel;
}

/**
 * The JSON Schema for ONE field's value. `refFor` decides how a `field.object` points at its
 * target — a file-relative `$ref` here, a `#/components/schemas/...` pointer in openapi.ts —
 * which is the one thing the two documents disagree about.
 *
 * The encodings follow the cross-port wire contract (docs/features/api-contract.md, "Type
 * encodings"): decimals travel as strings, currency as integer minor units, temporals as
 * ISO strings.
 */
export function fieldSchema(field: MetaField, refFor: (target: MetaObject) => string): JsonSchema {
  let value: JsonSchema;
  switch (field.subType) {
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:
      value = { type: "integer" };
      break;
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      value = { type: "number" };
      break;
    case FIELD_SUBTYPE_DECIMAL:
      value = { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" };
      break;
    case FIELD_SUBTYPE_BOOLEAN:
      value = { type: "boolean" };
      break;
    case FIELD_SUBTYPE_DATE:
      value = { type: "string", format: "date" };
      break;
    case FIELD_SUBTYPE_TIME:
      value = { type: "string", format: "time" };
      break;
    case FIELD_SUBTYPE_TIMESTAMP:
      // A @localTime timestamp is a naive wall clock (no `Z`), which `date-time` rejects.
      value = field.attr(FIELD_ATTR_LOCAL_TIME) === true
        ? { type: "string" }
        : { type: "string", format: "date-time" };
      break;
    case FIELD_SUBTYPE_UUID:
      value = { type: "string", format: "uuid" };
      break;
    case FIELD_SUBTYPE_URI:
      value = { type: "string", format: "uri" };
      break;
    case FIELD_SUBTYPE_INET:
      value = { type: "string", anyOf: [{ format: "ipv4" }, { format: "ipv6" }] };
      break;
    case FIELD_SUBTYPE_ENUM:
      value = { type: "string", enum: enumValues(field) ?? [] };
      break;
    case FIELD_SUBTYPE_MAP:
      value = { type: "object" };
      break;
    case FIELD_SUBTYPE_OBJECT: {
      const target = objectRefTarget(field);
      value = target === undefined ? { type: "object" } : { $ref: refFor(target) };
      break;
    }
    default:
      value = { type: "string" };
  }
  if (field.maxLength !== undefined) value.maxLength = field.maxLength;

  // resolvedIsArray(), never the raw `isArray` flag: an array-ness inherited through
  // `extends` lives on the parent field.
  const schema: JsonSchema = field.resolvedIsArray() ? { type: "array", items: value } : value;
  const description = field.attr(DOC_ATTR_DESCRIPTION);
  if (typeof description === "string") schema.description = description;
  // A derived (origin.*) field is computed by the database; clients never send it.
  if (field.isDerived()) schema.readOnly = true;
  return schema;
}

/** The `{ properties, required }` body shared by the file schema and the OpenAPI component. */
export function objectSchema(obj: MetaObject, refFor: (target: MetaObject) => string): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  // fields() RESOLVES: an entity that `extends` BaseEntity gets BaseEntity's fields too.
  for (const field of obj.fields()) {
    properties[field.name] = fieldSchema(field, refFor);
    if (field.isRequired) required.push(field.name);
  }
  const schema: JsonSchema = { title: obj.name, type: "object", properties };
  if (required.length > 0) schema.required = required;
  const description = obj.attr(DOC_ATTR_DESCRIPTION);
  if (typeof description === "string") schema.description = description;
  return schema;
}

export function jsonSchemaFile(opts: JsonSchemaFileOpts = {}): Generator {
  const generator: Generator = {
    name: "json-schema",
    // Abstract bases contribute shape through `extends`; they are not documents of their own.
    filter: (obj) => !isAbstract(obj) && (opts.filter?.(obj) ?? true),
    generate: perEntity((obj) => ({
      path: schemaPath(obj),
      content: `${JSON.stringify(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: schemaPath(obj),
          ...objectSchema(obj, (target) => relativeRef(obj, target)),
        },
        null,
        2,
      )}\n`,
    })),
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
