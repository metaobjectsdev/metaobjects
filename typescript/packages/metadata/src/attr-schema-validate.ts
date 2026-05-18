// Phase A3 — attribute-schema validation pass.
//
// Consumes the per-(type, subType) attribute schema populated in core-types.ts
// (Phase A2). For each node in the loaded typed tree, looks up
// registry.attrsOf(node.type, node.subType) and checks the node's OWN
// @-attributes against that schema:
//
//   1. Required attrs present       — every AttrSchema with required:true must
//                                      have a matching attr on the node.
//   2. Declared attrs well-typed    — for each @-attr ON the node that IS in the
//                                      schema, its runtime value type must match
//                                      the schema's valueType (an attr subtype).
//   3. allowedValues honored        — declared attrs with a non-empty
//                                      allowedValues set must hold a member value.
//   4. Undeclared attrs             — NOT an error, NOT a warning (open policy).
//
// `default` values are NOT auto-applied — A3 is pure validation, not mutation.
//
// Modeled on src/subtype-rules.ts: a recursive walk producing an
// { errors, warnings } result. All A3 findings are ERRORS; warnings stays [].

import type { AttrValue, MetaData } from "./meta/meta-data.js";
import { ParseError } from "./errors.js";
import type { AttrSchema, TypeRegistry } from "./registry.js";
import {
  type AttrSubType,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_STRINGARRAY,
} from "./constants.js";

export interface AttrSchemaValidationResult {
  errors: ParseError[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// attr-subtype → runtime-type check
// ---------------------------------------------------------------------------
//
// Numeric attr subtypes (int / long / double) all map to JS `number`. There is
// no separate short/byte/float/decimal attr subtype — ATTR_SUBTYPES has exactly
// the 9 entries below. `class` and `properties` are string-shaped on the wire.
//
// `stringarray` requires a real string[]. A single bare field name
// (e.g. `"@fields": "id"`) is the degenerate one-element authoring form, but
// the parser now desugars it to a one-element array before A3 runs (see
// normalizeStringArrayAttr in parser-json.ts). By the time A3 validates, every
// stringArray attr is already an array — so a bare string here is invalid.

const NUMERIC_ATTR_SUBTYPES: ReadonlySet<AttrSubType> = new Set([
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
]);

const STRING_ATTR_SUBTYPES: ReadonlySet<AttrSubType> = new Set([
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
]);

/** Returns true when `value`'s runtime type matches the declared attr subtype. */
function valueMatchesType(value: AttrValue, valueType: AttrSubType): boolean {
  if (STRING_ATTR_SUBTYPES.has(valueType)) {
    return typeof value === "string";
  }
  if (NUMERIC_ATTR_SUBTYPES.has(valueType)) {
    return typeof value === "number";
  }
  if (valueType === ATTR_SUBTYPE_BOOLEAN) {
    return typeof value === "boolean";
  }
  if (valueType === ATTR_SUBTYPE_STRINGARRAY) {
    // Must be a real string[]; the parser already desugared bare strings.
    return Array.isArray(value) && value.every((el) => typeof el === "string");
  }
  // SUBTYPE_BASE or any unexpected subtype — accept anything (no constraint).
  return true;
}

/** Human-readable name of an attr value's runtime type, for error messages. */
function runtimeTypeName(value: AttrValue): string {
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function validateAttrSchema(
  root: MetaData,
  registry: TypeRegistry,
): AttrSchemaValidationResult {
  const errors: ParseError[] = [];
  walk(root, registry, errors);
  return { errors, warnings: [] };
}

function walk(
  node: MetaData,
  registry: TypeRegistry,
  errors: ParseError[],
): void {
  validateNode(node, registry, errors);
  for (const child of node.ownChildren()) {
    walk(child, registry, errors);
  }
}

/** A node label for error messages, e.g. `origin.aggregate 'weekCount'`. */
function nodeLabel(node: MetaData): string {
  const head = `${node.type}.${node.subType}`;
  return node.name !== "" ? `${head} '${node.name}'` : head;
}

function validateNode(
  node: MetaData,
  registry: TypeRegistry,
  errors: ParseError[],
): void {
  const schema = registry.attrsOf(node.type, node.subType);
  if (schema.length === 0) return;

  // Index the schema by attr name for the declared-attr checks below.
  const byName = new Map<string, AttrSchema>();
  for (const spec of schema) byName.set(spec.name, spec);

  // --- Check 1: required attrs present ---
  //
  // Use effectiveAttrs() (own + inherited via extends:) to determine presence.
  // A node that legitimately inherits a required attr from its super must NOT be
  // flagged as missing it — inherited attrs count as satisfying the requirement.
  // Contrast with Checks 2+3 below, which iterate own attrs only: inherited attrs
  // were already validated on the node that declared them, so re-checking would
  // double-report. This mirrors the effective-vs-own split in subtype-rules.ts.
  const effective = node.effectiveAttrs();
  for (const spec of schema) {
    if (spec.required && !effective.has(spec.name)) {
      errors.push(
        new ParseError(
          `${nodeLabel(node)} is missing required attribute '@${spec.name}'`,
        ),
      );
    }
  }

  // --- Checks 2 + 3: declared attrs on the node are well-typed + in range ---
  for (const [attrName, value] of node.attrs()) {
    const spec = byName.get(attrName);
    if (spec === undefined) continue; // undeclared attr → open policy: ignore.

    // Check 2: value runtime type matches the declared valueType.
    if (!valueMatchesType(value, spec.valueType)) {
      errors.push(
        new ParseError(
          `${nodeLabel(node)} attribute '@${attrName}' must be of type ` +
            `'${spec.valueType}' but got ${runtimeTypeName(value)}`,
        ),
      );
      // Skip the allowedValues check when the type is already wrong —
      // a type mismatch makes the membership comparison meaningless.
      continue;
    }

    // Check 3: allowedValues membership.
    if (spec.allowedValues !== undefined && spec.allowedValues.length > 0) {
      if (!spec.allowedValues.includes(value)) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${attrName}' has value ` +
              `'${String(value)}' which is not one of the allowed values: ` +
              `${spec.allowedValues.map((v) => String(v)).join(", ")}`,
          ),
        );
      }
    }
  }
}
