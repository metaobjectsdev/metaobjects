// Stateless validation passes for the MetaDataLoader pipeline.
//
// Each function takes a fully-merged MetaData root and returns errors or
// warnings. No loader state is read or written — these are pure functions.
//
// Exported: validateDataGridSortFields, validateFilterableHasIndex,
//           validateOriginPaths  (called by MetaDataLoader.load() in order).
// Private:  _findObject, _findField, _findRelationship,
//           _validateFromPath, _validateViaPath  (helpers, not exported).

import type { MetaData } from "../meta/meta-data.js";
import { ParseError } from "../errors.js";
import {
  TYPE_OBJECT, TYPE_FIELD, TYPE_LAYOUT, TYPE_IDENTITY, TYPE_ORIGIN, TYPE_RELATIONSHIP,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_DB_INDEXED,
  IDENTITY_ATTR_FIELDS,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  RELATIONSHIP_ATTR_OBJECT_REF,
} from "../constants.js";

// ---------------------------------------------------------------------------
// Layout dataGrid @defaultSortField validation
// ---------------------------------------------------------------------------

export function validateDataGridSortFields(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use effectiveChildren() so inherited fields (via extends:/super:) are
    // visible when validating @defaultSortField references.
    const effective = obj.effectiveChildren();
    const fieldNames = new Set(
      effective.filter((c) => c.type === TYPE_FIELD).map((f) => f.name),
    );
    for (const layout of effective.filter((c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID)) {
      const sortField = layout.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
      if (typeof sortField === "string" && !fieldNames.has(sortField)) {
        errors.push(
          new ParseError(
            `dataGrid layout "${layout.name}" on entity "${obj.name}" has @defaultSortField "${sortField}" ` +
            `but no such field exists on "${obj.name}". Available fields: ${[...fieldNames].join(", ")}`,
          ),
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// @filterable without index validation
// ---------------------------------------------------------------------------

export function validateFilterableHasIndex(root: MetaData): string[] {
  const warnings: string[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // Use effectiveChildren() so inherited fields and identities (via extends:/super:)
    // are included when checking filterable-without-index.
    const effective = obj.effectiveChildren();
    // Build the set of field names that are part of any identity on this object.
    const indexedFieldNames = new Set<string>();
    for (const identity of effective.filter((c) => c.type === TYPE_IDENTITY)) {
      const fields = identity.attr(IDENTITY_ATTR_FIELDS);
      if (typeof fields === "string") {
        for (const name of fields.split(",")) indexedFieldNames.add(name.trim());
      } else if (Array.isArray(fields)) {
        for (const name of fields) if (typeof name === "string") indexedFieldNames.add(name);
      }
    }

    for (const field of effective.filter((c) => c.type === TYPE_FIELD)) {
      const filterable = field.attr(FIELD_ATTR_FILTERABLE);
      if (filterable !== true) continue;
      if (field.attr(FIELD_ATTR_DB_INDEXED) === true) continue;
      if (indexedFieldNames.has(field.name)) continue;
      warnings.push(
        `[filterable-without-index] field "${obj.name}.${field.name}" has @filterable: true but is not ` +
        `part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true ` +
        `to the field (when supported), or remove @filterable: true.`,
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Origin path validation
//
// Walks every projection's fields, finds `origin` (TYPE_ORIGIN) children,
// and validates:
//   - passthrough.@from resolves to an existing entity + field
//   - aggregate.@of resolves to an existing entity + field
//   - .@via paths resolve through real relationships, hopping entity-by-entity
//     using each relationship's @objectRef
//
// Note: @agg vocabulary is validated by validateAttrSchema (A3 pass) via
// allowedValues on the origin.aggregate @agg attr schema — not here.
// ---------------------------------------------------------------------------

function _findObject(root: MetaData, name: string): MetaData | undefined {
  return root.children().find((c) => c.type === TYPE_OBJECT && c.name === name);
}

function _findField(obj: MetaData, name: string): MetaData | undefined {
  // Use effectiveChildren() so inherited fields (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_FIELD && c.name === name);
}

function _findRelationship(obj: MetaData, name: string): MetaData | undefined {
  // Use effectiveChildren() so inherited relationships (via extends:/super:) are included.
  return obj.effectiveChildren().find((c) => c.type === TYPE_RELATIONSHIP && c.name === name);
}

function _validateFromPath(
  fromAttr: string,
  root: MetaData,
  projectionName: string,
  fieldName: string,
  errors: ParseError[],
  label: string = "origin.passthrough.@from",
): void {
  const dotIdx = fromAttr.indexOf(".");
  if (dotIdx < 1 || dotIdx === fromAttr.length - 1) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.field".`,
      ),
    );
    return;
  }
  const entityName = fromAttr.slice(0, dotIdx);
  const targetFieldName = fromAttr.slice(dotIdx + 1);
  const sourceObj = _findObject(root, entityName);
  if (!sourceObj) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
      ),
    );
    return;
  }
  const sourceField = _findField(sourceObj, targetFieldName);
  if (!sourceField) {
    errors.push(
      new ParseError(
        `${label} "${fromAttr}" on ${projectionName}.${fieldName}: no such field "${targetFieldName}" on ${entityName}.`,
      ),
    );
  }
}

function _validateViaPath(
  viaAttr: string,
  root: MetaData,
  projectionName: string,
  fieldName: string,
  errors: ParseError[],
): void {
  const segments = viaAttr.split(".");
  if (segments.length < 2) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: must be of form "Entity.relationship[.relationship...]".`,
      ),
    );
    return;
  }
  const [entityName, ...relSegments] = segments as [string, ...string[]];
  let currentObj = _findObject(root, entityName);
  if (!currentObj) {
    errors.push(
      new ParseError(
        `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such entity "${entityName}".`,
      ),
    );
    return;
  }
  for (const relName of relSegments) {
    const rel = _findRelationship(currentObj, relName);
    if (!rel) {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: no such relationship "${relName}" on ${currentObj.name}.`,
        ),
      );
      return;
    }
    const refTarget = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
    if (typeof refTarget !== "string" || refTarget === "") {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" on ${currentObj.name} is missing @objectRef.`,
        ),
      );
      return;
    }
    const nextObj = _findObject(root, refTarget);
    if (!nextObj) {
      errors.push(
        new ParseError(
          `origin.@via "${viaAttr}" on ${projectionName}.${fieldName}: relationship "${relName}" points to non-existent entity "${refTarget}".`,
        ),
      );
      return;
    }
    currentObj = nextObj;
  }
}

export function validateOriginPaths(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    for (const field of obj.children().filter((c) => c.type === TYPE_FIELD)) {
      for (const origin of field.children().filter((c) => c.type === TYPE_ORIGIN)) {
        if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
          const from = origin.attr(ORIGIN_PASSTHROUGH_ATTR_FROM);
          if (typeof from !== "string" || from === "") {
            errors.push(
              new ParseError(
                `origin.passthrough on ${obj.name}.${field.name}: missing @from.`,
              ),
            );
            continue;
          }
          _validateFromPath(from, root, obj.name, field.name, errors);
          const via = origin.attr(ORIGIN_PASSTHROUGH_ATTR_VIA);
          if (typeof via === "string" && via !== "") {
            _validateViaPath(via, root, obj.name, field.name, errors);
          }
        } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
          const of_ = origin.attr(ORIGIN_AGGREGATE_ATTR_OF);
          if (typeof of_ !== "string" || of_ === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @of.`,
              ),
            );
            continue;
          }
          _validateFromPath(of_, root, obj.name, field.name, errors, "origin.aggregate.@of");
          const via = origin.attr(ORIGIN_AGGREGATE_ATTR_VIA);
          if (typeof via !== "string" || via === "") {
            errors.push(
              new ParseError(
                `origin.aggregate on ${obj.name}.${field.name}: missing @via (aggregates require a relationship path).`,
              ),
            );
            continue;
          }
          _validateViaPath(via, root, obj.name, field.name, errors);
        }
      }
    }
  }
  return errors;
}
