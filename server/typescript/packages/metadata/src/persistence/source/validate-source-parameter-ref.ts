// Validation pass: source.rdb @parameterRef typed-input rules (FR-015).
//
// Codes:
//   ERR_PARAMETER_REF_UNRESOLVED         — @parameterRef names a non-existent object.
//   ERR_PARAMETER_REF_NOT_VALUE_OBJECT   — @parameterRef points at an object.entity
//                                          instead of object.value.
//   ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND
//                                        — @parameterRef set with @kind: "table" /
//                                          "view" / "materializedView". Only the
//                                          callable kinds (storedProc, tableFunction)
//                                          accept parameters.
//
// Passthrough type-matching on parameter fields is NOT emitted here: it was
// retired (#185) into the universal ERR_PASSTHROUGH_TYPE_MISMATCH enforced in
// validateOriginPaths, which runs over parameter-ref value objects too.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import {
  TYPE_OBJECT,
  TYPE_SOURCE,
} from "../../shared/base-types.js";
import {
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_ENTITY,
} from "../../core/object/object-constants.js";
import { resolveObjectRef } from "../../naming-refs.js";
import { MetaSource } from "./meta-source.js";
import {
  SOURCE_ATTR_PARAMETER_REF,
  SOURCE_SUBTYPE_RDB,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
} from "./source-constants.js";

const CALLABLE_KINDS = new Set<string>([
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
]);

export function validateSourceParameterRef(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0042: a bare @parameterRef resolves package-local (this object's
    // package, else root-level); an FQN resolves exactly. Shares the single
    // resolveObjectRef matcher — NO bare-name-anywhere fallback (which would
    // silently bind a same-named value-object in another package).
    const referrerPkg = obj.package ?? obj.fileDefaultPackage ?? "";
    // ADR-0039: own — declaration-layer source iteration (mirrors validateSourceRoles).
    for (const source of obj.ownChildren().filter(
      (c): c is MetaSource =>
        c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_RDB && c instanceof MetaSource,
    )) {
      // ADR-0039: resolving — a source may inherit @parameterRef via extends.
      const ref = source.attr(SOURCE_ATTR_PARAMETER_REF);
      if (typeof ref !== "string" || ref === "") continue;

      // ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND — checked even before resolution
      // so authoring mistakes on the wrong kind surface immediately.
      if (!CALLABLE_KINDS.has(source.effectiveKind)) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" has @parameterRef but @kind is "${source.effectiveKind}"; ` +
              `only "storedProc" or "tableFunction" accept parameters`,
            { code: "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND", source: source.source },
          ),
        );
        continue;
      }

      const target = resolveObjectRef(root, ref, referrerPkg).node;
      if (target === undefined) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" @parameterRef = "${ref}" does not resolve to any known object`,
            { code: "ERR_PARAMETER_REF_UNRESOLVED", source: source.source },
          ),
        );
        continue;
      }

      if (target.subType !== OBJECT_SUBTYPE_VALUE) {
        const reason = target.subType === OBJECT_SUBTYPE_ENTITY
          ? "an object.entity (entities have identity; parameter shapes are value-objects)"
          : `an object.${target.subType}`;
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" @parameterRef = "${ref}" resolves to ${reason}; ` +
              `use an object.value`,
            { code: "ERR_PARAMETER_REF_NOT_VALUE_OBJECT", source: source.source },
          ),
        );
        continue;
      }

      // #185 — passthrough type-preservation (parameter fields forwarding an
      // entity field via origin.passthrough must match its type) is enforced
      // UNIVERSALLY by _checkPassthroughType in validateOriginPaths (which runs
      // over every object incl. these parameter-ref value-objects), emitting
      // ERR_PASSTHROUGH_TYPE_MISMATCH. The narrow, subtype-only
      // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH that used to live here was
      // retired in favour of that single invariant (which also gates array-ness
      // and honours the @convert opt-out).
    }
  }

  return errors;
}
