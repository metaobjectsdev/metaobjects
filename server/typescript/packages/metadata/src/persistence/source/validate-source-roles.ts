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
import { SOURCE_ROLE_PRIMARY } from "./source-constants.js";

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

  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
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
  }

  return errors;
}
