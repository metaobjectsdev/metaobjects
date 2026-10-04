// A report's READ MODEL (FR-044): a detached object carrying one real `field.*`
// child per derived field (Table B) and a copy of the report's own read-only source.
//
// WHY IT EXISTS
//
// An `object.report` declares no fields: its read shape is derived from its
// dimensions and measures. A metadata-driven runtime walks an object's field
// children in a dozen places (column list, filter and sort resolution, the name
// map, every read coercion). Rather than teach each of them what a report is, the
// runtime reads a report through this model and sees ordinary fields.
//
// WHY IT IS DETACHED
//
// The model is never added to the root: it has no parent, `root.objects()` does
// not list it, and the canonical serializer, `fmt`, codegen and every other tree
// walker never see it. Nothing in the loaded tree is mutated to build it; in
// particular the report's own source node is COPIED, not re-parented
// (`addChild` rewrites the child's parent). The nodes are constructed directly,
// not through the registry, so the sealed registry is not involved and no
// vocabulary is added: every node is an already-registered `type.subType`.
//
// It keeps the report's name, package and `object.report` subtype, so a consumer
// holding it can still tell it is a report (no identity, read-only).

import { TypeId } from "../../registry.js";
import { TYPE_FIELD } from "../../shared/base-types.js";
import type { MetaRoot } from "../../shared/meta-root.js";
import { isReadOnlySource } from "../../shared/node-guards.js";
import { MetaSource } from "../../persistence/source/meta-source.js";
import { FIELD_ATTR_DB_COLUMN_TYPE, FIELD_ATTR_LOCAL_TIME } from "../../persistence/db/db-constants.js";
import { MetaObject } from "../object/meta-object.js";
import { MetaField } from "../field/meta-field.js";
import {
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_INT_VALUE_MAP,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_VALUES,
} from "../field/field-constants.js";
import { reportShape, type ReportField } from "./report-shape.js";

/**
 * Table B: the type-shaping attrs a derived field carries from its `typeSource`,
 * read with the RESOLVING accessor (ADR-0039) so a value the `@of` field inherits
 * through `extends` is carried too. `@dbColumnType` and `isArray` are handled
 * separately below. Nothing else is carried: no `@column`, `@required`,
 * `@default`, validators or views.
 */
const CARRIED_ATTRS = [
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_INT_VALUE_MAP,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
] as const;

function derivedField(f: ReportField): MetaField {
  const field = new MetaField(new TypeId(TYPE_FIELD, f.subType), f.name);
  // From the derived shape, never from the type source: a `min` of a required column
  // is still nullable, and a dimension reached by `@via` is nullable.
  field.setAttr(FIELD_ATTR_REQUIRED, f.required);
  const src = f.typeSource;
  if (src !== undefined) {
    for (const name of CARRIED_ATTRS) {
      const value = src.attr(name);
      if (value !== undefined) field.setAttr(name, value);
    }
    // ADR-0039: own — `@dbColumnType` is the one deliberately own-only attr (a
    // physical column-type override is never inherited), and every consumer reads
    // it with `ownAttr`. So it is read own from the type source and set OWN here:
    // the derived field carries exactly what the `@of` field itself declares, and
    // nothing its supers declare. A field that `extends` another does not get the
    // parent's `@dbColumnType` either, so this matches how a projection field
    // would see it.
    const dbColumnType = src.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
    if (dbColumnType !== undefined) field.setAttr(FIELD_ATTR_DB_COLUMN_TYPE, dbColumnType);
    // `isArray` is a native flag, not an attr; resolvedIsArray() is its resolving read.
    if (src.resolvedIsArray()) field.setIsArray(true);
  }
  return field;
}

/** A detached copy of a source node: same `type.subType`, name and effective attrs. */
function copySource(source: MetaSource): MetaSource {
  const copy = new MetaSource(source.typeId, source.name);
  // ADR-0039: resolving — the copy carries the source's effective configuration
  // (@kind, the physical-name alias, @schema, @role, @unmanaged, @sql).
  for (const [name, value] of source.attrs()) copy.setAttr(name, value);
  return copy;
}

const READ_MODELS = new WeakMap<MetaObject, MetaObject>();

/**
 * The read model of an `object.report`: one field per Table B row, in Table B
 * order, plus a copy of the report's own read-only source when it declares one
 * (Table A). A sourceless report yields a model with no source: it has a shape
 * and no view, and the caller decides what that means (the runtime refuses to
 * serve it).
 *
 * Cached per report node; the model is frozen. Throws what `reportShape` throws
 * when a reference does not resolve.
 */
export function reportReadModel(report: MetaObject, root: MetaRoot): MetaObject {
  const cached = READ_MODELS.get(report);
  if (cached !== undefined) return cached;

  const shape = reportShape(report, root);
  const model = new MetaObject(report.typeId, report.name);
  if (report.package !== undefined) model.setPackage(report.package);
  if (report.fileDefaultPackage !== undefined) model.setFileDefaultPackage(report.fileDefaultPackage);
  for (const f of shape.fields) model.addChild(derivedField(f));

  // ADR-0039: own — Table A classifies a report by the source it declares ITSELF,
  // the same own-source read as codegen's `classifyReadOnlySource`, so the runtime
  // serves exactly the reports whose view the lowering (or the adopter) provides.
  const source = report.ownChildren().find(isReadOnlySource);
  if (source !== undefined) model.addChild(copySource(source));

  model.freeze();
  READ_MODELS.set(report, model);
  return model;
}
