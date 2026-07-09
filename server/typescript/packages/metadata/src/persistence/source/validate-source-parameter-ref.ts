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
import { PACKAGE_SEPARATOR } from "../../shared/structural.js";
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

  // Pre-index every object by name, fqn AND effective FQN resolution key so
  // resolution costs O(1) per source. FR-032 — @parameterRef is FQN-qualified
  // after the desugar/sweep, but objects keep a BARE fqn() per the FR5d
  // contract, so the FQN form `<package | fileDefaultPackage>::<name>` only
  // matches via resolutionKey() (these fixtures declare package at metadata.root
  // only, so obj.package is undefined and the file-default must be folded in).
  const objectIndex = new Map<string, MetaData>();
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    objectIndex.set(obj.name, obj);
    const fqn = obj.package !== undefined && obj.package !== ""
      ? `${obj.package}${PACKAGE_SEPARATOR}${obj.name}`
      : obj.name;
    objectIndex.set(fqn, obj);
    objectIndex.set(obj.resolutionKey(), obj);
  }

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
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

      const target = objectIndex.get(ref);
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
