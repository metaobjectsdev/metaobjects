// Validation pass: one-primary multi-source rule.
//
// An object that declares ≥1 source MUST have exactly one with role "primary".
// Zero sources is allowed (object is not persisted). Violations:
//   ERR_SOURCE_NO_PRIMARY      — sources present but none is role "primary"
//   ERR_SOURCE_MULTIPLE_PRIMARY — more than one source has role "primary"

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import { TYPE_OBJECT, TYPE_SOURCE } from "../../shared/base-types.js";
import { MetaSource } from "./meta-source.js";
import { SOURCE_ROLE_PRIMARY, SOURCE_READ_ONLY_KINDS } from "./source-constants.js";
import { OBJECT_SUBTYPE_ENTITY } from "../../core/object/object-constants.js";

/**
 * Walks every object in the root and enforces the one-primary rule for
 * multi-source objects:
 *  - 0 sources → no error (object is not backed by any store).
 *  - 1+ sources, exactly 1 with role "primary" → OK.
 *  - 1+ sources, 0 with role "primary" → ERR_SOURCE_NO_PRIMARY.
 *  - 1+ sources, 2+ with role "primary" → ERR_SOURCE_MULTIPLE_PRIMARY.
 */
export function validateSourceRoles(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: own — the one-primary rule is a DECLARATION-layer check (cross-port
    // parity: Java uses getSources(false)); it counts sources declared on THIS object,
    // not inherited ones. The role/kind reads below resolve via MetaSource getters.
    const sources = obj
      .ownChildren()
      .filter((c) => c.type === TYPE_SOURCE)
      .map((c) => c as MetaSource);

    if (sources.length === 0) continue;

    const primaryCount = sources.filter((s) => s.role === SOURCE_ROLE_PRIMARY).length;

    if (primaryCount === 0) {
      errors.push(
        new ParseError(
          `object "${obj.name}" declares ${sources.length} source(s) but none has role "${SOURCE_ROLE_PRIMARY}"`,
          { code: "ERR_SOURCE_NO_PRIMARY", source: obj.source },
        ),
      );
    } else if (primaryCount > 1) {
      errors.push(
        new ParseError(
          `object "${obj.name}" declares ${primaryCount} sources with role "${SOURCE_ROLE_PRIMARY}"; exactly one is required`,
          { code: "ERR_SOURCE_MULTIPLE_PRIMARY", source: obj.source },
        ),
      );
    }

    // FR-024 (ADR-0028) — THE HARD CUTOVER: an entity's PRIMARY source must be
    // writable; read-only kinds (view/materializedView/storedProc/tableFunction)
    // are legal only in non-primary (read) roles. The pre-FR-024 spellings
    // (view-primary "projection" entities, proc-result-as-entity) are removed
    // outright — a derived read model is an `object.projection`.
    if (obj.subType === OBJECT_SUBTYPE_ENTITY) {
      for (const s of sources) {
        if (s.role === SOURCE_ROLE_PRIMARY && SOURCE_READ_ONLY_KINDS.has(s.effectiveKind)) {
          errors.push(
            new ParseError(
              `entity "${obj.name}" has a primary source of read-only kind "${s.effectiveKind}" — ` +
                `read-only kinds are legal only in non-primary roles; a derived read model ` +
                `is an object.projection (FR-024, ADR-0028)`,
              { code: "ERR_ENTITY_PRIMARY_SOURCE_READONLY", source: s.source },
            ),
          );
        }
      }
    }
  }

  return errors;
}
