// FR-022 — one field as JSON Schema 2020-12. Pure: it reads the field and returns a plain value.
//
// The encodings are the REST contract's, not the persistence corpus's comparator form
// (docs/features/api-contract.md, "Type encodings"): a long is a JSON number, a currency is integer
// minor units, a time has no offset, and a @localTime timestamp has no `Z`. A decimal is the one
// encoding that is a project setting, so it reads `wire.decimals` and never the port, which is what
// keeps these bytes neutral.
//
// The constraints mirror what the generated write validators enforce (`appendValidatorChain`):
// the same bounds on the same field shapes, so a schema neither promises more nor refuses more.

import {
  type MetaField,
  type MetaObject,
  WIRE_DECIMALS_STRING,
  type WireFormat,
} from "@metaobjectsdev/metadata";
import {
  DB_COLUMN_TYPE_JSONB,
  DOC_ATTR_DESCRIPTION,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_DB_COLUMN_TYPE,
  FIELD_ATTR_LENIENT,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_STRING_FORMAT,
  FIELD_ATTR_VALUE_TYPE,
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
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_UUID,
  STRING_FORMAT_EMAIL,
  STRING_FORMAT_HOSTNAME,
  VALIDATOR_ATTR_MAX,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_REGEX,
} from "@metaobjectsdev/metadata/constants";
import { enumValues } from "../enum-meta.js";
import { objectRefTarget } from "../model-walk.js";

/** A JSON Schema, as a plain object in the key order it is written. */
export type JsonSchema = { [key: string]: unknown };

/**
 * The three wire shapes of an object: what a read answers, what POST takes and what PATCH takes.
 * They differ (a generated id is not sent, a credential is not returned, a PATCH requires nothing),
 * so one schema per object cannot state all three.
 */
export type ContractShape = "read" | "create" | "update";

/** How a schema points at another object's schema: a relative file, or a component. */
export type RefFor = (target: MetaObject, shape: ContractShape) => string;

/** The canonical decimal string (ADR-0019 Amendment 1): plain notation, no trailing fraction zeros. */
export const DECIMAL_CANONICAL_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$";
/** A decimal as a request may send it: a string in JSON-number grammar. */
export const DECIMAL_INPUT_PATTERN = "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$";
/** `HH:MM:SS[.fff]`. The RFC 3339 `time` format demands an offset, which this wire form does not carry. */
export const TIME_PATTERN = "^[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$";
/** A @localTime timestamp: a naive wall clock, which `date-time` refuses for having no offset. */
export const LOCAL_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$";

/**
 * An instant as a request may send it. Every port's routes take a value with no offset and read it
 * as UTC (the api-contract corpus sends one), which `date-time` refuses, so a write states what a
 * route takes and a read states what it answers.
 */
const TIMESTAMP_INPUT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})?$";

const NUMERIC_SUBTYPES: ReadonlySet<string> = new Set([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
]);

function isJsonbBag(field: MetaField): boolean {
  return field.subType === FIELD_SUBTYPE_STRING && field.attr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB;
}

function decimalPrecisionNote(field: MetaField): string {
  const precision = field.attr(FIELD_ATTR_PRECISION);
  const scale = field.attr(FIELD_ATTR_SCALE);
  if (typeof precision !== "number" || typeof scale !== "number") return "";
  return ` Precision ${String(precision)}, scale ${String(scale)}.`;
}

/** A decimal. An answer follows `wire.decimals`; a request takes either form in every mode. */
function decimalSchema(field: MetaField, shape: ContractShape, wire: WireFormat): JsonSchema {
  const note = decimalPrecisionNote(field);
  if (shape !== "read") {
    return {
      type: ["string", "number"],
      pattern: DECIMAL_INPUT_PATTERN,
      description: `A decimal, as a string in JSON-number grammar or a JSON number.${note}`,
    };
  }
  if (wire.decimals === WIRE_DECIMALS_STRING) {
    return { type: "string", pattern: DECIMAL_CANONICAL_PATTERN };
  }
  return {
    type: ["string", "number"],
    description: `A decimal. Set wire.decimals to "string" to fix one form across server languages.${note}`,
  };
}

/** A timestamp as a request or a filter operand sends it. */
export function timestampInputSchema(field: MetaField): JsonSchema {
  if (field.attr(FIELD_ATTR_LOCAL_TIME) === true) return { type: "string", pattern: LOCAL_TIMESTAMP_PATTERN };
  return { type: "string", pattern: TIMESTAMP_INPUT_PATTERN, description: "An instant. A value with no offset is read as UTC." };
}

/** A scalar field type by subtype name, with no constraints. A map's `@valueType` reads this too. */
export function scalarSchema(subType: string): JsonSchema {
  switch (subType) {
    case FIELD_SUBTYPE_INT: return { type: "integer", format: "int32" };
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY: return { type: "integer", format: "int64" };
    case FIELD_SUBTYPE_DOUBLE: return { type: "number", format: "double" };
    case FIELD_SUBTYPE_FLOAT: return { type: "number", format: "float" };
    case FIELD_SUBTYPE_BOOLEAN: return { type: "boolean" };
    case FIELD_SUBTYPE_DATE: return { type: "string", format: "date" };
    case FIELD_SUBTYPE_TIME: return { type: "string", pattern: TIME_PATTERN };
    case FIELD_SUBTYPE_TIMESTAMP: return { type: "string", format: "date-time" };
    case FIELD_SUBTYPE_UUID: return { type: "string", format: "uuid" };
    case FIELD_SUBTYPE_URI: return { type: "string", format: "uri" };
    case FIELD_SUBTYPE_INET: return { type: "string", anyOf: [{ format: "ipv4" }, { format: "ipv6" }] };
    case FIELD_SUBTYPE_DECIMAL: return { type: "string", pattern: DECIMAL_INPUT_PATTERN };
    default: return { type: "string" };
  }
}

/** An enum as a string. With no values to state it stays open: `enum: []` would refuse everything. */
export function enumSchema(field: MetaField): JsonSchema {
  const values = enumValues(field);
  return values === undefined || values.length === 0 ? { type: "string" } : { type: "string", enum: values };
}

/** One value of a field that holds no reference to another object. */
function plainValueSchema(field: MetaField, shape: ContractShape, wire: WireFormat): JsonSchema {
  const lenient = field.attr(FIELD_ATTR_LENIENT) === true;
  switch (field.subType) {
    case FIELD_SUBTYPE_DECIMAL:
      return decimalSchema(field, shape, wire);
    case FIELD_SUBTYPE_TIMESTAMP:
      if (shape !== "read") return timestampInputSchema(field);
      return field.attr(FIELD_ATTR_LOCAL_TIME) === true
        ? { type: "string", pattern: LOCAL_TIMESTAMP_PATTERN }
        : scalarSchema(field.subType);
    case FIELD_SUBTYPE_URI:
    case FIELD_SUBTYPE_INET:
      return lenient ? { type: "string" } : scalarSchema(field.subType);
    case FIELD_SUBTYPE_ENUM:
      return enumSchema(field);
    case FIELD_SUBTYPE_CURRENCY: {
      const code = field.attr(FIELD_ATTR_CURRENCY);
      const unit = typeof code === "string" ? ` of ${code}` : "";
      return { ...scalarSchema(field.subType), description: `Integer minor units${unit}.` };
    }
    case FIELD_SUBTYPE_STRING: {
      if (isJsonbBag(field)) return {};
      const format = field.attr(FIELD_ATTR_STRING_FORMAT);
      if (format === STRING_FORMAT_EMAIL) return { type: "string", format: "email" };
      if (format === STRING_FORMAT_HOSTNAME) return { type: "string", format: "hostname" };
      return { type: "string" };
    }
    default:
      return scalarSchema(field.subType);
  }
}

/** A nested shape is the matching shape of the target. A write takes the target's create shape. */
function nestedShape(shape: ContractShape): ContractShape {
  return shape === "read" ? "read" : "create";
}

function objectValueSchema(field: MetaField, shape: ContractShape, refFor: RefFor): JsonSchema {
  const target = objectRefTarget(field);
  return target === undefined ? { type: "object" } : { $ref: refFor(target, nestedShape(shape)) };
}

function mapValueSchema(field: MetaField, shape: ContractShape, refFor: RefFor): JsonSchema {
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  const target = typeof ref === "string" && ref.length > 0 ? objectRefTarget(field) : undefined;
  if (target !== undefined) {
    return { type: "object", additionalProperties: { $ref: refFor(target, nestedShape(shape)) } };
  }
  const valueType = field.attr(FIELD_ATTR_VALUE_TYPE);
  return { type: "object", additionalProperties: scalarSchema(typeof valueType === "string" ? valueType : FIELD_SUBTYPE_STRING) };
}

interface FieldBounds {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

/** The bounds a field's validators state, folded as `appendValidatorChain` folds them. */
function boundsOf(field: MetaField): FieldBounds {
  const bounds: FieldBounds = {};
  const maxLength = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof maxLength === "number") bounds.maxLength = maxLength;
  // ADR-0039: resolving — a validator may inherit @min/@max/@pattern via extends.
  for (const v of field.validators()) {
    const min = v.attr(VALIDATOR_ATTR_MIN);
    const max = v.attr(VALIDATOR_ATTR_MAX);
    if (v.subType === VALIDATOR_SUBTYPE_LENGTH) {
      if (typeof min === "number") bounds.minLength = min;
      // FR-036 A3: @maxLength × validator.length @max is strictest-wins.
      if (typeof max === "number") bounds.maxLength = bounds.maxLength === undefined ? max : Math.min(bounds.maxLength, max);
    } else if (v.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = v.attr(VALIDATOR_ATTR_PATTERN);
      // FR-036 Pin 2: @pattern is full-match, and JSON Schema's `pattern` searches.
      if (typeof pattern === "string") bounds.pattern = `^(?:${pattern})$`;
    } else if (v.subType === VALIDATOR_SUBTYPE_NUMERIC) {
      if (typeof min === "number") bounds.minimum = min;
      if (typeof max === "number") bounds.maximum = max;
    } else if (v.subType === VALIDATOR_SUBTYPE_ARRAY) {
      if (typeof min === "number") bounds.minItems = min;
      if (typeof max === "number") bounds.maxItems = max;
    }
  }
  return bounds;
}

/** Bounds on the one value of a scalar: characters of a string, the value of a number. */
function applyScalarBounds(schema: JsonSchema, field: MetaField, shape: ContractShape, bounds: FieldBounds): void {
  if (field.subType === FIELD_SUBTYPE_STRING && !isJsonbBag(field)) {
    // FR-036 Pin 1: a @required string is non-empty on a write, unless an authored @min says otherwise.
    const floor = shape !== "read" && field.isRequired ? 1 : 0;
    const minLength = bounds.minLength ?? floor;
    if (minLength > 0) schema.minLength = minLength;
    if (bounds.maxLength !== undefined) schema.maxLength = bounds.maxLength;
    if (bounds.pattern !== undefined) schema.pattern = bounds.pattern;
  } else if (NUMERIC_SUBTYPES.has(field.subType)) {
    if (bounds.minimum !== undefined) schema.minimum = bounds.minimum;
    if (bounds.maximum !== undefined) schema.maximum = bounds.maximum;
  }
}

function joinDescription(first: unknown, second: unknown): string | undefined {
  const parts = [first, second].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * The JSON Schema of a field's value in one shape. Null is the caller's to add: see `withNull`.
 * `wire` is the loaded root's setting: a report's read model has no root of its own to read.
 */
export function fieldSchema(field: MetaField, shape: ContractShape, refFor: RefFor, wire: WireFormat): JsonSchema {
  const value: JsonSchema = field.subType === FIELD_SUBTYPE_OBJECT
    ? objectValueSchema(field, shape, refFor)
    : field.subType === FIELD_SUBTYPE_MAP
      ? mapValueSchema(field, shape, refFor)
      : plainValueSchema(field, shape, wire);

  const bounds = boundsOf(field);
  let schema = value;
  // resolvedIsArray(), never the raw `isArray` flag: array-ness inherited through `extends` lives
  // on the parent field. An array's bounds count elements (`appendValidatorChain`).
  if (field.resolvedIsArray()) {
    schema = { type: "array", items: value };
    if (bounds.minItems !== undefined) schema.minItems = bounds.minItems;
    if (bounds.maxItems !== undefined) schema.maxItems = bounds.maxItems;
  } else {
    applyScalarBounds(schema, field, shape, bounds);
  }

  const description = joinDescription(field.attr(DOC_ATTR_DESCRIPTION), schema.description);
  if (description !== undefined) schema.description = description;
  return schema;
}

/** The schema that also accepts `null`. Safe on one that already does: `type` entries must be unique. */
export function withNull(schema: JsonSchema): JsonSchema {
  if (Object.keys(schema).length === 0) return schema; // an open value already holds null
  if (schema.$ref !== undefined) {
    const { description, ...ref } = schema;
    return { anyOf: [ref, { type: "null" }], ...(description !== undefined && { description }) };
  }
  const out: JsonSchema = { ...schema };
  const type = schema.type;
  if (typeof type === "string") out.type = [type, "null"];
  else if (Array.isArray(type) && !type.includes("null")) out.type = [...type, "null"];
  // `enum` is checked on its own: without null in it, a nullable enum still refuses null.
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) out.enum = [...schema.enum, null];
  return out;
}
