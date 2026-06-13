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
//   ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH
//                                        — a parameter field uses origin.passthrough
//                                          @from: "Entity.field" but the parameter's
//                                          subtype does not match the referenced
//                                          field's subtype.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import {
  TYPE_OBJECT,
  TYPE_SOURCE,
  TYPE_FIELD,
  TYPE_ORIGIN,
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
import {
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
} from "../../persistence/origin/origin-constants.js";

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
  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    objectIndex.set(obj.name, obj);
    const fqn = obj.package !== undefined && obj.package !== ""
      ? `${obj.package}${PACKAGE_SEPARATOR}${obj.name}`
      : obj.name;
    objectIndex.set(fqn, obj);
    objectIndex.set(obj.resolutionKey(), obj);
  }

  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    for (const source of obj.ownChildren().filter(
      (c): c is MetaSource =>
        c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_RDB && c instanceof MetaSource,
    )) {
      const ref = source.ownAttr(SOURCE_ATTR_PARAMETER_REF);
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

      // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH — every parameter field
      // with origin.passthrough must have a subtype matching the referenced
      // field. The origin path validation pass checks the from-path resolves;
      // here we just check the subtype alignment.
      for (const paramField of target.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
        const passthrough = paramField.ownChildren().find(
          (c) => c.type === TYPE_ORIGIN && c.subType === ORIGIN_SUBTYPE_PASSTHROUGH,
        );
        if (passthrough === undefined) continue;
        const from = passthrough.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
        if (typeof from !== "string" || from === "") continue;
        const dot = from.indexOf(".");
        if (dot < 0) continue;
        const targetEntityName = from.slice(0, dot);
        const targetFieldName = from.slice(dot + 1);
        const targetEntity = objectIndex.get(targetEntityName);
        if (targetEntity === undefined) continue; // origin-paths pass surfaces this
        const targetField = targetEntity.ownChildren().find(
          (c) => c.type === TYPE_FIELD && c.name === targetFieldName,
        );
        if (targetField === undefined) continue;
        if (paramField.subType !== targetField.subType) {
          errors.push(
            new ParseError(
              `parameter field "${paramField.name}" (field.${paramField.subType}) on @parameterRef ` +
                `"${ref}" uses origin.passthrough @from: "${from}", but ` +
                `${targetEntity.name}.${targetFieldName} is field.${targetField.subType}; types must match`,
              { code: "ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH", source: paramField.source },
            ),
          );
        }
      }
    }
  }

  return errors;
}
