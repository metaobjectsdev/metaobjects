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
import { SOURCE_ATTR_ROLE, SOURCE_ROLE_PRIMARY } from "../../persistence/source/source-constants.js";
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

/**
 * The source a report is READ from: its own read-only source with `@role: primary`,
 * else its first own read-only source. Undefined when it declares none (Table A:
 * not lowered, not served).
 *
 * This is the rule that NAMES the lowered view — `viewName` / `projectionViewSource`
 * in codegen-ts's `projection/extract-view-spec.ts`, reached for a report through
 * `projectionViewName`. It is restated here because the metadata package cannot
 * depend on a codegen package; the two must stay the same rule, or the runtime
 * reads a relation the lowering did not create.
 *
 * What the loader permits, measured: a report may declare several read-only sources
 * (a `@role: replica` view beside its primary view loads clean, in either order);
 * `@role` defaults to `primary`; a report whose sources include no primary is
 * `ERR_SOURCE_NO_PRIMARY` and a writable source on a report is refused. So for every
 * model that loads, the primary branch fires. The first-read-only fallback covers a
 * tree built in code, and keeps this rule identical to the lowering's.
 */
export function reportReadSource(report: MetaObject): MetaSource | undefined {
  // ADR-0039: own — source classification reads the sources the report declares
  // ITSELF, exactly as the lowering's `viewName` does.
  const readOnly = report.ownChildren().filter(isReadOnlySource);
  return readOnly.find((s) => s.role === SOURCE_ROLE_PRIMARY) ?? readOnly[0];
}

/**
 * A detached copy of a source node: same `type.subType`, name and effective attrs,
 * and nothing else (attrs only — the loaded node is never re-parented).
 *
 * The copy is the model's ONLY source, and it is pinned to `@role: primary`: the
 * runtime resolves an object's table through `primaryRdbSource`, which considers
 * primary sources only, so this is what makes the read land on the selected
 * source's physical name rather than on a default table name nobody declared.
 */
function copySource(source: MetaSource): MetaSource {
  const copy = new MetaSource(source.typeId, source.name);
  // ADR-0039: resolving — the copy carries the source's effective configuration
  // (@kind, the physical-name alias, @schema, @unmanaged, @sql).
  for (const [name, value] of source.attrs()) copy.setAttr(name, value);
  copy.setAttr(SOURCE_ATTR_ROLE, SOURCE_ROLE_PRIMARY);
  return copy;
}

const READ_MODELS = new WeakMap<MetaObject, MetaObject>();

/**
 * The read model of an `object.report`: one field per Table B row, in Table B
 * order, plus a copy of the source the report is read from (see
 * `reportReadSource`) when it declares one (Table A). A sourceless report yields a model with no source: it has a shape
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

  const source = reportReadSource(report);
  if (source !== undefined) model.addChild(copySource(source));

  model.freeze();
  READ_MODELS.set(report, model);
  return model;
}
