// Does this object have a generated HTTP API surface?
//
// THIS is the question the UI tier should ask. A hook, a grid and a form are all
// clients of a REST endpoint: hooks fetch one, a grid renders what a hook returned,
// a form submits to one. None of them knows or cares where the data is stored — that
// is the whole point of the architecture, and `@metaobjectsdev/runtime-web` is
// deliberately browser-only with no database dependency at all.
//
// The UI generators used to ask `hasAnyRdbSource` directly, which produced the RIGHT
// answer for the WRONG reason: routes are currently derived from sources (FR-008/009
// derived CRUD), so "has a relational source" and "has an endpoint" happen to
// coincide today. They are not the same question, and the coincidence is temporary —
// FR-024 declared `api.*` surfaces and #211 non-RDB projection materialization both
// break it, at which point a UI tier reaching through to storage starts refusing to
// generate hooks for entities that genuinely do have endpoints.
//
// So the reach-through lives in exactly one place now, named for what it means. When
// route derivation grows a second source of truth, this function changes and every
// UI generator follows for free.
//
// Three questions since FR-044: `servesReadApi` asks whether a read endpoint exists (the
// route and queries generators), `servesClientHooks` asks whether a typed client hook is
// generated for it, and `servesClientTier` asks whether the rest of the client UI tier (a
// grid, its grid hook, the Angular service) is. They differ for a served report, which has
// a route and a list hook and no grid, form or detail hook.

import {
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_OBJECT_REF,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_OBJECT,
  OBJECT_SUBTYPE_VALUE,
  TYPE_FIELD,
  VIEW_SUBTYPE_PASSWORD,
  WIRE_DECIMALS_STRING,
  WIRE_NULL_MEMBERS_NATIVE,
  refTarget,
  wireFormatOf,
  type MetaData,
  type MetaField,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { isAbstract } from "./instance-artifacts.js";
import { isProjection } from "./projection/projection-detector.js";
import { hasAnyRdbSource, hasWritableRdbSource, isReport, servedReport } from "./source-detect.js";
import { getPkFields } from "./pk-resolver.js";
import { resourcePath, restPath } from "./templates/entity-ui-descriptor.js";
import { declaresTphDiscriminator, isTphSubtype, tphDiscriminatorBase, tphDiscriminatorPin } from "./tph.js";
import { tphRouteSegment } from "./templates/tph-discriminator.js";

/**
 * True when the object is served by a generated READ endpoint.
 *
 * Abstract types are excluded (no instance to address). Today the endpoint test is
 * "declares or inherits a `source.rdb`", which is precisely the predicate
 * `routesFile` / `routesFileHono` gate on. The hook generator asks `servesClientHooks`
 * (this answer) and the grid generators ask `servesClientTier`, which is this answer
 * minus reports.
 */
export function servesReadApi(entity: MetaObject): boolean {
  // FR-044 Plan 3: a report is served exactly when Table A says so (`servedReport`: not
  // abstract, read source `@kind: view`). The question is asked of the declared report
  // node by the doors that read the model directly (docs, owned generators) and of its
  // read model by the generators `runGen` drives; both answer the same. A report whose
  // read-only source is any other kind passes the source test below and is served by
  // nothing, so a report never reaches that test.
  if (isReport(entity)) return servedReport(entity);
  return !isAbstract(entity) && hasAnyRdbSource(entity);
}

/**
 * True when the read-only surface of the object has `/:id` routes, a by-id query and a
 * detail hook: the object declares a primary identity, and the column it names is a field
 * of the object.
 *
 * - A report (the declared node or its read model) never has one, even when a derived
 *   field happens to be named `id`: a report has no identity, and its rows are groups.
 * - A projection with no declared primary identity has none either, even when it has a
 *   field named `id`. There is no declared key to address a row by, and "a field called
 *   `id`" is a convention, not a key. This is the JVM and C# rule
 *   (`RestSurfaceGate.hasItemRoute`), and the rule of the cross-port `projection/` corpus.
 * - A composite identity answers true: its by-id query reads the first component.
 *
 * Only the read-only templates ask. The writable surface emits item routes unconditionally.
 */
export function hasItemRoute(entity: MetaObject): boolean {
  return itemRouteField(entity) !== undefined;
}

/**
 * The field a read-only object's item routes address a row by, or `undefined` when it has
 * none (`hasItemRoute` is exactly "this is defined"). It is `getPkInfo`'s field, so the
 * by-id query and the mounted `GET /:id` read the same column.
 *
 * The read-only mount addresses `id` unless told otherwise, so a routes template passes
 * this as the mount's `idColumn` whenever it is not `id`. Without that, a projection keyed
 * on `code` mounted a `/:id` route that compared nothing and answered with the view's
 * first row.
 */
export function itemRouteField(entity: MetaObject): string | undefined {
  if (isReport(entity)) return undefined;
  // ADR-0039: resolving. `getPkFields` reads `primaryIdentity()` and `findField` reads
  // `fields()`, both of which walk the super chain; a projection's identity and its key
  // field are typically inherited from its base entity.
  const idField = getPkFields(entity)[0];
  return idField !== undefined && entity.findField(idField) !== undefined ? idField : undefined;
}

/**
 * True when a typed client hook is generated for the object: `servesReadApi(entity)`.
 * A served report is included. It gets the list hook (`use<Report>s`, with the report's
 * filter and sort types) and nothing else: `hasItemRoute` is false for it, so no detail
 * hook, and it has no writable source, so no mutation hooks. `agent/ui.md` lists the
 * objects this answers true for.
 */
export function servesClientHooks(entity: MetaObject): boolean {
  return servesReadApi(entity);
}

/**
 * True when the rest of the client UI tier (a grid, its grid hook, the Angular service)
 * is generated for the object: `servesReadApi(entity)` and not a report. A served report
 * has a route and a list hook (`servesClientHooks`) and no grid; a grid over reports
 * belongs to the later `reporting` library.
 */
export function servesClientTier(entity: MetaObject): boolean {
  return servesReadApi(entity) && !isReport(entity);
}

/**
 * The names of an object's `field.decimal` fields, which its generated routes send as canonical
 * strings (ADR-0019 Amendment 1, W1 and W4).
 *
 * A decimal is a canonical string on the wire on EVERY dialect and for every kind of object (an
 * entity, a projection, a report): Postgres `numeric` and MySQL `DECIMAL` hand back the column's
 * scale (`"100.5000"`), and SQLite hands back a JS number (the REAL a report's view computes, or
 * the number a NUMERIC-affinity column stores). The generated route passes these names to the
 * mount as `decimalColumns` and the mount rewrites each row under them. Which keys are decimals
 * comes from the model, never from the shape of a value. Empty for an object with no decimal,
 * which keeps its route byte-identical. A decimal declared `isArray` is listed too: the mount
 * rewrites each element of its array.
 */
export function decimalFieldNames(entity: MetaObject): readonly string[] {
  // ADR-0039: resolving. A decimal may be inherited via extends, and a report read model's
  // derived ratio, average or sum is a field of the report itself.
  return entity.fields().filter((f) => f.subType === FIELD_SUBTYPE_DECIMAL).map((f) => f.name);
}

/**
 * True when the field is a credential: it declares a `view.password` ("masked input for
 * sensitive values"), the one place the metamodel already says a value is secret.
 *
 * A generated CRUD route can never be a correct writer of a credential (it has no hashing
 * seam), nor a safe reader of one, so a credential is never read or written through the
 * generated API. Filter and sort allowlists are unchanged (`@filterable` and `@sortable` stay
 * explicit opt-ins), so do not put them on a credential: a filter on a secret is an oracle for
 * it. The application writes it itself, through its own code.
 */
export function isCredentialField(field: MetaField): boolean {
  // ADR-0039: resolving. A view may be inherited via extends.
  return field.views().some((v) => v.subType === VIEW_SUBTYPE_PASSWORD);
}

/**
 * True when the generated API never writes the field: `@formExclude` (the field is out of the
 * generated form, so no form-driven write reaches it either) or a credential.
 */
export function isApiWriteDenied(field: MetaField): boolean {
  // ADR-0039: resolving. @formExclude may be inherited via extends.
  return field.attr(FIELD_ATTR_FORM_EXCLUDE) === true || isCredentialField(field);
}

/**
 * The names of the fields of `objects` that `isMarked` holds for on ANY declaration in
 * `hierarchy`, in field order. A single-table (TPH) column declared by several subtypes is one
 * column, so a credential or `@formExclude` on one declaration counts on every subtype that has it.
 */
function markedFieldNames(
  objects: readonly MetaObject[],
  hierarchy: readonly MetaObject[],
  isMarked: (f: MetaField) => boolean,
): string[] {
  const marked = new Set(hierarchy.flatMap((o) => o.fields().filter(isMarked).map((f) => f.name)));
  return [...new Set(objects.flatMap((o) => o.fields().map((f) => f.name)))].filter((n) => marked.has(n));
}

/**
 * The `writeDeniedColumns` line of a mount that accepts writes, or "" when no field is denied
 * (the output stays byte-identical for a model with no `@formExclude` or credential field).
 * `hierarchy` is a TPH subtype's base and every subtype, when the mount serves one.
 */
export function writeDeniedColumnsLine(entity: MetaObject, indent: string, hierarchy: readonly MetaObject[] = [entity]): string {
  const names = markedFieldNames([entity], hierarchy, isApiWriteDenied);
  return names.length === 0 ? "" : `\n${indent}writeDeniedColumns: ${JSON.stringify(names)},`;
}

/** The declared shape of a value object, as a generated mount takes it (`ValueObjectShape` in runtime-ts). */
interface ValueObjectShapeData {
  members: string[];
  map?: true;
  nested?: Record<string, ValueObjectShapeData>;
}

/** The value object a `field.object` / `field.map` field references, or undefined. */
function valueObjectOf(field: MetaData): MetaData | undefined {
  if (field.subType !== FIELD_SUBTYPE_OBJECT && field.subType !== FIELD_SUBTYPE_MAP) return undefined;
  const target = refTarget(field, FIELD_ATTR_OBJECT_REF);
  return target?.subType === OBJECT_SUBTYPE_VALUE ? target : undefined;
}

function shapeOf(field: MetaData, vo: MetaData, path: readonly MetaData[]): ValueObjectShapeData {
  // ADR-0039: resolving. A value object's members may be inherited via extends.
  const fields = vo.children().filter((c) => c.type === TYPE_FIELD);
  const shape: ValueObjectShapeData = { members: fields.map((f) => f.name) };
  if (field.subType === FIELD_SUBTYPE_MAP) shape.map = true;
  for (const f of fields) {
    const inner = valueObjectOf(f);
    // A value object that contains itself is walked once: the stored value is finite, and
    // shaping stops where the declaration repeats.
    if (inner === undefined || path.includes(inner)) continue;
    (shape.nested ??= {})[f.name] = shapeOf(f, inner, [...path, inner]);
  }
  return shape;
}

/** The jsonb columns of `entity` that hold a value object (or an array / map of them), with their declared shape. */
export function valueObjectShapes(entity: MetaObject): Record<string, ValueObjectShapeData> {
  const out: Record<string, ValueObjectShapeData> = {};
  for (const f of entity.fields()) {
    const vo = valueObjectOf(f);
    if (vo !== undefined) out[f.name] = shapeOf(f, vo, [vo]);
  }
  return out;
}

/**
 * The wire options a generated mount takes (ADR-0019 Amendment 2), one `\n<indent>key: value,`
 * line each, or "" when the object needs none:
 *
 *  - `decimalColumns`: the object's `field.decimal` names (always, when it has any: under
 *    `native` the mount still renders a SQLite number at 15 digits);
 *  - `decimalWire: "string"`: only when the project asks for canonical strings;
 *  - `nullMembers` + `valueObjects`: only when the project asks to `emit` or `omit` null
 *    members and the object has a value-object column.
 *
 * The setting is the project's, read from the root. Several objects share one mount when a
 * single-table (TPH) base's polymorphic route serves its subtypes' rows too: pass them all,
 * so a decimal or value object only a subtype declares is still covered. `root` is the loaded
 * root the setting is read from (`ctx.loadedRoot`). `hierarchy` widens the credential marks to a
 * TPH subtype's base and every subtype, when the mount serves one.
 */
export function decimalColumnsLine(
  entity: MetaObject | readonly MetaObject[],
  indent: string,
  root?: MetaData,
  hierarchy?: readonly MetaObject[],
): string {
  const objects: readonly MetaObject[] = Array.isArray(entity) ? entity : [entity as MetaObject];
  const first = objects[0];
  if (first === undefined) return "";
  // A report's read model is a detached object with no root of its own, so a generator passes the
  // loaded root; without one the object's own root answers.
  const wire = wireFormatOf(root ?? first);
  const names = [...new Set(objects.flatMap((o) => decimalFieldNames(o)))];
  let lines = "";
  const hidden = markedFieldNames(objects, hierarchy ?? objects, isCredentialField);
  if (hidden.length > 0) lines += `\n${indent}hiddenColumns: ${JSON.stringify(hidden)},`;
  if (names.length > 0) {
    lines += `\n${indent}decimalColumns: ${JSON.stringify(names)},`;
    if (wire.decimals === WIRE_DECIMALS_STRING) lines += `\n${indent}decimalWire: ${JSON.stringify(wire.decimals)},`;
  }
  if (wire.nullMembers !== WIRE_NULL_MEMBERS_NATIVE) {
    const shapes: Record<string, ValueObjectShapeData> = {};
    for (const o of objects) for (const [column, shape] of Object.entries(valueObjectShapes(o))) shapes[column] ??= shape;
    if (Object.keys(shapes).length > 0) {
      lines += `\n${indent}nullMembers: ${JSON.stringify(wire.nullMembers)},`;
      lines += `\n${indent}valueObjects: ${JSON.stringify(shapes)},`;
    }
  }
  return lines;
}

/**
 * True when the object is served by generated WRITE endpoints — so a form has
 * somewhere to submit. Requires a WRITABLE source: the same predicate the entity-file
 * generator uses to decide whether `Insert`/`Update` schemas exist at all, so a form
 * can never be emitted against schemas that were never generated.
 */
export function servesWriteApi(entity: MetaObject): boolean {
  return !isAbstract(entity) && hasWritableRdbSource(entity);
}

// `restPath` MOVED to templates/entity-ui-descriptor.ts, beside `resourcePath` and the
// descriptor that emits `$path` from it. Re-exported here because this module is where
// the package barrel and `generators/agent-ui-page.ts` import it from, and neither should
// have to care that the composition moved.
export { restPath } from "./templates/entity-ui-descriptor.js";

/**
 * The address the generated routes actually SERVE an object at: the mount prefix plus the
 * object's REST path.
 *
 * One function, because getting this wrong is the defect it exists to prevent, twice over.
 * `agent/ui.md` documented `/authors` for routes mounted at `/api/authors`; the API
 * reference did the same, separately, in two more places — three doors composing one
 * address, each free to drift from the others. `templates/routes-file-hono.ts` and
 * `routes-file.ts` compose the same thing into GENERATED code and remain the runtime
 * authority; this is the documentation side mirroring them.
 */
export function servedPath(entity: MetaObject, apiPrefix: string): string {
  return `${apiPrefix}${restPath(entity)}`;
}

/**
 * True when a FORM is generated for this object.
 *
 * `servesWriteApi` is NOT the same question, and the difference is a TPH hierarchy. The
 * discriminator BASE has a writable SOURCE — which is all `servesWriteApi` asks — but no
 * write ENDPOINT: `routes-file.ts` mounts it with `expose: ["list", "get"]`, because the
 * discriminated union has no single writable shape. So it gets no form, and there would be
 * nowhere to submit one. Each concrete SUBTYPE gets a form, even though it owns no writable
 * source of its own. A read-only projection gets none: it is instantiable for read, never
 * for write.
 *
 * This is the form generator's own filter, hoisted so `agent/ui.md` can say "there is
 * deliberately no form here" for the same set of objects the generator skips. Asking
 * `servesWriteApi` on the page instead announced a form for every discriminator base.
 */
export function hasGeneratedForm(entity: MetaObject): boolean {
  if (isTphSubtype(entity)) return true; // per-subtype form
  // A discriminator base is never form-rendered directly; `entity` is already known not
  // to be a subtype.
  if (declaresTphDiscriminator(entity)) return false;
  return servesWriteApi(entity) && !isProjection(entity);
}
