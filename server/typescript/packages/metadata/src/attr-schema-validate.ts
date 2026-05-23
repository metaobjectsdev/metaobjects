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
//                                      schema, its value must satisfy the
//                                      MetaAttr instance's own validateValue.
//   3. allowedValues honored        — declared attrs with a non-empty
//                                      allowedValues set must hold a member value.
//   4. Undeclared attrs             — NOT an error, NOT a warning (open policy).
//
// `default` values are NOT auto-applied — A3 is pure validation, not mutation.
//
// Checks 2+3 dispatch to the materialized MetaAttr instance: each attr is a
// MetaAttr that owns validateValue(value): ValueError[] (resolved by its
// subType, which the parser chose from the declared valueType). The central
// value-shape helper + the per-shape subtype sets are gone — value-shape
// knowledge now lives on the instance. The pass maps each ValueError to a
// ParseError with the unchanged ERR_BAD_ATTR_VALUE code, so conformance
// fixtures stay green.
//
// Modeled on src/subtype-rules.ts: a recursive walk producing an
// { errors, warnings } result. All A3 findings are ERRORS; warnings stays [].

import type { MetaData } from "./shared/meta-data.js";
import { ParseError } from "./errors.js";
import type { AttrSchema, TypeRegistry } from "./registry.js";
import { TYPE_FIELD } from "./shared/base-types.js";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  ENUM_MEMBER_PATTERN,
} from "./core/field/field-constants.js";

export interface AttrSchemaValidationResult {
  errors: ParseError[];
  warnings: string[];
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
  // Use attrs() (own + inherited via extends:) to determine presence.
  // A node that legitimately inherits a required attr from its super must NOT be
  // flagged as missing it — inherited attrs count as satisfying the requirement.
  // Contrast with Checks 2+3 below, which iterate own attrs only: inherited attrs
  // were already validated on the node that declared them, so re-checking would
  // double-report. This mirrors the effective-vs-own split in subtype-rules.ts.
  const effective = node.attrs();
  for (const spec of schema) {
    if (spec.required && !effective.has(spec.name)) {
      errors.push(
        new ParseError(
          `${nodeLabel(node)} is missing required attribute '@${spec.name}'`,
          { code: "ERR_MISSING_REQUIRED_ATTR" },
        ),
      );
    }
  }

  // --- Checks 2 + 3: declared attrs on the node are well-typed + in range ---
  for (const inst of node.ownMetaAttrs()) {
    const spec = byName.get(inst.name);
    if (spec === undefined) continue; // undeclared attr → open policy: ignore.
    const value = inst.value;
    if (value === undefined) continue;

    // Check 2: the instance validates its own value shape. When the declared
    // valueType is absent (e.g. @default), skip — any AttrValue is valid.
    if (spec.valueType !== undefined) {
      const valueErrors = inst.validateValue(value);
      if (valueErrors.length > 0) {
        for (const ve of valueErrors) {
          errors.push(new ParseError(`${nodeLabel(node)} ${ve.message}`, { code: "ERR_BAD_ATTR_VALUE" }));
        }
        continue; // type wrong → skip allowedValues
      }
    }

    // Check 3: allowedValues membership (unchanged).
    if (spec.allowedValues !== undefined && spec.allowedValues.length > 0) {
      if (!spec.allowedValues.includes(value)) {
        errors.push(
          new ParseError(
            `${nodeLabel(node)} attribute '@${inst.name}' has value ` +
              `'${String(value)}' which is not one of the allowed values: ` +
              `${spec.allowedValues.map((v) => String(v)).join(", ")}`,
            { code: "ERR_BAD_ATTR_VALUE" },
          ),
        );
      }
    }
  }

  // --- Check 4: field.enum @values content rules ---
  //
  // Only for field.enum nodes that carry an own @values attr (concrete or
  // abstract). Concrete fields that extend an abstract enum inherit @values
  // from the super; the super was already validated when it was declared, so
  // only own @values need checking here (mirrors the own-attrs-only policy of
  // Checks 2+3 above — inherited attrs were validated on the declaring node).
  if (node.type === TYPE_FIELD && node.subType === FIELD_SUBTYPE_ENUM) {
    const rawValues = node.ownAttrs().get(FIELD_ATTR_VALUES);
    if (Array.isArray(rawValues)) {
      const seen = new Set<string>();
      for (const member of rawValues) {
        if (typeof member !== "string") continue; // already rejected by Check 2
        if (!ENUM_MEMBER_PATTERN.test(member)) {
          errors.push(
            new ParseError(
              `${nodeLabel(node)} attribute '@${FIELD_ATTR_VALUES}' member '${member}' ` +
                `is not a valid identifier (must match ^[A-Za-z_][A-Za-z0-9_]*$). ` +
                `Non-identifier-safe member strings require a symbol↔value mapping (deferred).`,
              { code: "ERR_BAD_ATTR_VALUE" },
            ),
          );
        } else if (seen.has(member)) {
          errors.push(
            new ParseError(
              `${nodeLabel(node)} attribute '@${FIELD_ATTR_VALUES}' has duplicate member '${member}'.`,
              { code: "ERR_BAD_ATTR_VALUE" },
            ),
          );
        } else {
          seen.add(member);
        }
      }
    }
  }
}
