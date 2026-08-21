// Validation pass: field-level @mutability cross-attribute rules (FR-037 R1).
//
// @mutability is ONE axis — who may write this field, and when — with three
// mutually exclusive modes, `readWrite` (default) < `writeOnce` < `readOnly`.
// Modelling it as one enum rather than two booleans is what makes the illegal
// pair unrepresentable and gives inheritance a total order.
//
// Codes:
//   ERR_MUTABILITY_AUTOSET_CONFLICT — @autoSet on a field whose @mutability is
//     `writeOnce` or `readOnly`. @autoSet already says the SERVER supplies the
//     value; that is a different axis from who may write it, and the pair says
//     two contradictory things about the same column. The boolean era left
//     readOnly × @autoSet representable but UNVALIDATED — the enum cut closes
//     both arms with one rule.
//   ERR_MUTABILITY_DOWNGRADE — a subtype LOOSENS an inherited mode. Replaces
//     ERR_READONLY_DOWNGRADE: the rule now spans three modes, so a code named
//     READONLY would misdescribe a `writeOnce` → `readWrite` loosening.
//   ERR_READONLY_ASSIGNED_PRIMARY — KEEPS ITS NAME: the condition is genuinely
//     readOnly-specific. Note the asymmetry that justifies the enum — `writeOnce`
//     on an assigned primary key is LEGAL, and indeed the natural declaration:
//     the caller supplies the key on create and can never change it after.
//   WARN_MUTABILITY_VALUE_OBJECT — a non-default @mutability on a field child of
//     object.value. A value has no persistence semantics, so the contract is
//     advisory (codegen may still use it for record/struct treatment).
//   WARN_MUTABILITY_READONLY_HOST — `writeOnce` on a host nothing writes anyway
//     (a projection, or a read-only source @kind). Benign, not an error: the
//     declaration is merely inert, and a projection legitimately `extends` an
//     entity whose field carries it.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import type { LoaderWarning } from "../../source.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_SOURCE,
} from "../../shared/base-types.js";
import { OBJECT_SUBTYPE_VALUE, OBJECT_SUBTYPE_PROJECTION } from "../object/object-constants.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_FIELDS,
  GENERATION_ASSIGNED,
} from "../identity/identity-constants.js";
import {
  FIELD_ATTR_MUTABILITY,
  FIELD_ATTR_AUTO_SET,
  MUTABILITY_READ_WRITE,
  MUTABILITY_WRITE_ONCE,
  MUTABILITY_READ_ONLY,
  MUTABILITY_MODES,
  type MutabilityMode,
} from "./field-constants.js";
import { isReadOnlySource } from "../../shared/node-guards.js";

export interface FieldMutabilityValidationResult {
  errors: ParseError[];
  warnings: LoaderWarning[];
}

/**
 * A field's EFFECTIVE mutability mode — resolving (ADR-0039), so a concrete
 * field inheriting from an abstract parent sees the parent's declaration.
 * Absent ⇒ `readWrite`. THE accessor every consumer should use.
 */
export function fieldMutability(field: MetaData): MutabilityMode {
  const v = field.attr(FIELD_ATTR_MUTABILITY);
  return isMutabilityMode(v) ? v : MUTABILITY_READ_WRITE;
}

/** True when nothing may write this field — the `@readOnly: true` of the old
 *  vocabulary. Does NOT cover derived (origin-bearing) fields; callers that
 *  need both compose this with `isDerived()`, exactly as before. */
export function isReadOnlyMutability(field: MetaData): boolean {
  return fieldMutability(field) === MUTABILITY_READ_ONLY;
}

/** True when the field is settable on create but excluded from the update shape. */
export function isWriteOnceMutability(field: MetaData): boolean {
  return fieldMutability(field) === MUTABILITY_WRITE_ONCE;
}

function isMutabilityMode(v: unknown): v is MutabilityMode {
  return typeof v === "string" && (MUTABILITY_MODES as readonly string[]).includes(v);
}

/** The mode's rank on the tightening order. Declaration order IS the order, so
 *  "may only tighten" is an index comparison, not a lookup table. */
function rank(mode: MutabilityMode): number {
  return (MUTABILITY_MODES as readonly string[]).indexOf(mode);
}

export function validateFieldMutability(root: MetaData): FieldMutabilityValidationResult {
  const errors: ParseError[] = [];
  const warnings: LoaderWarning[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    const isValueObject = obj.subType === OBJECT_SUBTYPE_VALUE;
    const hostNeverWritten = isWriteHostReadOnly(obj);

    for (const ownField of obj.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
      // ADR-0039: own — these are own-vs-super comparisons by design. `ownMode`
      // must see what THIS node declared: resolving would mask a downgrade, and
      // would also warn on a value that merely inherited the mode.
      const ownDeclared = ownField.ownAttr(FIELD_ATTR_MUTABILITY);
      const ownMode = isMutabilityMode(ownDeclared) ? ownDeclared : undefined;

      // 1) WARN_MUTABILITY_VALUE_OBJECT — a non-default mode declared on a value's
      //    own field. Advisory: a value has no persistence semantics.
      if (isValueObject && ownMode !== undefined && ownMode !== MUTABILITY_READ_WRITE) {
        warnings.push({
          code: "WARN_MUTABILITY_VALUE_OBJECT",
          message:
            `field "${ownField.name}" on object.value "${obj.name}" declares ` +
            `@mutability: "${ownMode}"; value objects have no persistence semantics, so the ` +
            `write contract is advisory (codegen may use it for record/struct treatment).`,
          source: ownField.source,
        });
      }

      // 2) ERR_MUTABILITY_DOWNGRADE — a subtype may TIGHTEN an inherited mode,
      //    never loosen it. Rank comparison over the declaration order.
      if (ownMode !== undefined) {
        const inherited = inheritedField(obj, ownField.name);
        if (inherited !== undefined) {
          const inheritedMode = declaredMode(inherited);
          if (inheritedMode !== undefined && rank(ownMode) < rank(inheritedMode)) {
            errors.push(
              new ParseError(
                `field "${ownField.name}" on "${obj.name}" sets @mutability: "${ownMode}", but ` +
                  `its extends-chain parent declares "${inheritedMode}". A subtype may only ` +
                  `TIGHTEN an inherited mode (${MUTABILITY_MODES.join(" < ")}), never loosen it ` +
                  `(FR-037 R1).`,
                { code: "ERR_MUTABILITY_DOWNGRADE", source: ownField.source },
              ),
            );
          }
        }
      }
    }

    // The remaining rules read the EFFECTIVE tree — an inherited mode is just as
    // binding as a declared one for "is this combination coherent?".
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      const mode = fieldMutability(field);

      // 3) ERR_MUTABILITY_AUTOSET_CONFLICT — @autoSet with a non-readWrite mode.
      //    Both arms: readOnly (representable-but-unvalidated in the boolean era)
      //    and writeOnce (new). @autoSet means the SERVER supplies the value, so
      //    constraining who ELSE may write it is contradictory, not additive.
      if (mode !== MUTABILITY_READ_WRITE && field.attr(FIELD_ATTR_AUTO_SET) !== undefined) {
        errors.push(
          new ParseError(
            `field "${field.name}" on "${obj.name}" declares @autoSet together with ` +
              `@mutability: "${mode}". @autoSet already means the SERVER supplies the value; ` +
              `@mutability says who may write it. Drop @mutability (an @autoSet field is ` +
              `already excluded from every input shape) or drop @autoSet (FR-037 R1).`,
            { code: "ERR_MUTABILITY_AUTOSET_CONFLICT", source: field.source },
          ),
        );
      }

      // 5) WARN_MUTABILITY_READONLY_HOST — writeOnce on a host nothing writes.
      //    Benign: the declaration is inert, not wrong, and a projection may
      //    legitimately inherit it from the entity it extends.
      if (mode === MUTABILITY_WRITE_ONCE && hostNeverWritten) {
        warnings.push({
          code: "WARN_MUTABILITY_READONLY_HOST",
          message:
            `field "${field.name}" on "${obj.name}" declares @mutability: "writeOnce", but its ` +
            `host is never written (a projection, or a read-only source @kind). The declaration ` +
            `is inert — nothing creates a row here for it to be settable on.`,
          source: field.source,
        });
      }
    }

    // 4) ERR_READONLY_ASSIGNED_PRIMARY — readOnly on an ASSIGNED primary key.
    //    Note what is NOT here: `writeOnce` on an assigned key is legal, and is
    //    the natural declaration for one. That asymmetry is why this code keeps
    //    its readOnly-specific name.
    if (!isValueObject) {
      const primaryAssignedFields = primaryAssignedFieldNames(obj);
      if (primaryAssignedFields.size > 0) {
        for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
          if (!primaryAssignedFields.has(field.name)) continue;
          if (fieldMutability(field) !== MUTABILITY_READ_ONLY) continue;
          errors.push(
            new ParseError(
              `field "${field.name}" on "${obj.name}" is @mutability: "readOnly" AND the target ` +
                `of identity.primary with @generation: "assigned"; the application has no path ` +
                `to populate the identity value. Use @mutability: "writeOnce" if the intent is ` +
                `"set once on create, never changed" (FR-037 R1).`,
              { code: "ERR_READONLY_ASSIGNED_PRIMARY", source: field.source },
            ),
          );
        }
      }
    }
  }

  return { errors, warnings };
}

/** The mode a node DECLARED (own), or undefined when it declared none. */
function declaredMode(field: MetaData): MutabilityMode | undefined {
  // ADR-0039: own — the downgrade rule needs the EXPLICIT mode on the DECLARING
  // node; resolving would report the child's own value back at itself.
  const v = field.ownAttr(FIELD_ATTR_MUTABILITY);
  return isMutabilityMode(v) ? v : undefined;
}

/** True when no write path reaches this object: an object.projection, or an
 *  object whose every source is a read-only `@kind`. */
function isWriteHostReadOnly(obj: MetaData): boolean {
  if (obj.subType === OBJECT_SUBTYPE_PROJECTION) return true;
  // ADR-0039: resolving — a source may be inherited via extends.
  const sources = obj.children().filter((c) => c.type === TYPE_SOURCE);
  if (sources.length === 0) return false;
  return sources.every((s) => isReadOnlySource(s));
}

/** Walk the extends chain looking for a field with the same name; return its
 *  declaring node (own attrs preserved) if found. */
function inheritedField(obj: MetaData, name: string): MetaData | undefined {
  let cursor = obj.superResolved;
  while (cursor !== undefined) {
    // ADR-0039: own — super-chain walk reading each level's OWN fields to find the
    // declaring node (the comparison needs the declaring node's own mode).
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
