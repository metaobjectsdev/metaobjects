// Validation pass: field-level @readOnly cross-attribute rules (FR-013).
//
// Codes:
//   ERR_READONLY_ASSIGNED_PRIMARY — @readOnly: true on a field that is the
//     target of an identity.primary with @generation: "assigned". The application
//     has no path to populate the identity value (no setter; not generated; not
//     defaulted).
//   ERR_READONLY_DOWNGRADE — a concrete subtype declares @readOnly: false on a
//     field whose extends-chain parent declares @readOnly: true. Read-only-ness
//     can only be upgraded, never downgraded.
//   WARN_READONLY_VALUE_OBJECT — @readOnly: true on a field child of object.value.
//     The persistence implication does not apply; the attr is retained for
//     language-specific record/struct treatment.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import type { LoaderWarning } from "../../source.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
} from "../../shared/base-types.js";
import { OBJECT_SUBTYPE_VALUE } from "../object/object-constants.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_FIELDS,
  GENERATION_ASSIGNED,
} from "../identity/identity-constants.js";
import { FIELD_ATTR_READ_ONLY } from "./field-constants.js";

export interface FieldReadOnlyValidationResult {
  errors: ParseError[];
  warnings: LoaderWarning[];
}

export function validateFieldReadOnly(root: MetaData): FieldReadOnlyValidationResult {
  const errors: ParseError[] = [];
  const warnings: LoaderWarning[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    const isValueObject = obj.subType === OBJECT_SUBTYPE_VALUE;

    // 1) WARN_READONLY_VALUE_OBJECT — any @readOnly field child of an object.value.
    if (isValueObject) {
      // ADR-0039: own — warns on @readOnly DECLARED on this value's own fields
      // (readOnlyFlag reads the explicit own flag; the FR-013 read-only checks
      // are own-vs-super comparisons by design).
      for (const child of obj.ownChildren()) {
        if (child.type === TYPE_FIELD && readOnlyFlag(child) === true) {
          warnings.push({
            code: "WARN_READONLY_VALUE_OBJECT",
            message:
              `field "${child.name}" on object.value "${obj.name}" declares ` +
              `@readOnly: true; value-objects have no persistence semantics so ` +
              `the read-only contract is advisory (codegen may use it for record/` +
              `struct treatment).`,
            source: child.source,
          });
        }
      }
    }

    // 2) ERR_READONLY_DOWNGRADE — read-only-ness can only be upgraded across
    //    extends. Compare own field vs. inherited field's effective @readOnly.
    // ADR-0039: own — the downgrade check compares this object's OWN explicit
    // @readOnly:false against the inherited effective value (own-vs-super by design).
    for (const ownField of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      const ownVal = readOnlyFlag(ownField);
      if (ownVal !== false) continue; // only the explicit downgrade case matters
      const inherited = inheritedField(obj, ownField.name);
      if (inherited !== undefined && readOnlyFlag(inherited) === true) {
        errors.push(
          new ParseError(
            `field "${ownField.name}" on "${obj.name}" sets @readOnly: false, but the ` +
              `extends-chain parent declares @readOnly: true. Read-only-ness can only be ` +
              `upgraded, not downgraded (FR-013).`,
            { code: "ERR_READONLY_DOWNGRADE", source: ownField.source },
          ),
        );
      }
    }

    // 3) ERR_READONLY_ASSIGNED_PRIMARY — @readOnly: true on a field used in an
    //    identity.primary whose @generation is "assigned" (effective tree).
    if (!isValueObject) {
      const primaryAssignedFields = primaryAssignedFieldNames(obj);
      if (primaryAssignedFields.size > 0) {
        for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
          if (!primaryAssignedFields.has(field.name)) continue;
          if (readOnlyFlag(field) !== true) continue;
          errors.push(
            new ParseError(
              `field "${field.name}" on "${obj.name}" is @readOnly: true AND the target ` +
                `of identity.primary with @generation: "assigned"; the application has no ` +
                `path to populate the identity value (FR-013).`,
              { code: "ERR_READONLY_ASSIGNED_PRIMARY", source: field.source },
            ),
          );
        }
      }
    }
  }

  return { errors, warnings };
}

/** Read the explicit @readOnly value from a field's own attrs. Returns
 *  true / false when explicitly set, undefined when absent. */
function readOnlyFlag(field: MetaData): boolean | undefined {
  // ADR-0039: own — the FR-013 downgrade rule needs the EXPLICIT own @readOnly on
  // THIS node (detecting an own :false against an inherited :true); resolving would
  // mask the downgrade. Deliberate own-vs-super comparison.
  const v = field.ownAttr(FIELD_ATTR_READ_ONLY);
  if (typeof v === "boolean") return v;
  return undefined;
}

/** Walk the extends chain looking for a field with the same name; return its
 *  declaring node (own attrs preserved) if found. */
function inheritedField(obj: MetaData, name: string): MetaData | undefined {
  let cursor = obj.superResolved;
  while (cursor !== undefined) {
    // ADR-0039: own — super-chain walk reading each level's OWN fields to find the
    // declaring node (the FR-013 comparison needs the declaring node's own flag).
    const f = cursor.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === name);
    if (f !== undefined) return f;
    cursor = cursor.superResolved;
  }
  return undefined;
}

/** Names of fields participating in any identity.primary with @generation:
 *  "assigned" on `obj` or its extends chain. */
function primaryAssignedFieldNames(obj: MetaData): Set<string> {
  const out = new Set<string>();
  for (const id of obj.children()) {
    if (id.type !== TYPE_IDENTITY) continue;
    if (id.subType !== IDENTITY_SUBTYPE_PRIMARY) continue;
    // ADR-0039: resolving — an identity may inherit @generation / @fields via extends.
    const gen = id.attr(IDENTITY_ATTR_GENERATION);
    if (gen !== GENERATION_ASSIGNED) continue;
    const fields = id.attr(IDENTITY_ATTR_FIELDS);
    if (Array.isArray(fields)) {
      for (const fName of fields) {
        if (typeof fName === "string") out.add(fName);
      }
    } else if (typeof fields === "string") {
      out.add(fields);
    }
  }
  return out;
}
