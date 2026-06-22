// expected-views.ts — derive ViewDescriptor[] from projection metadata.
//
// Ports the shape of csharp/MetaObjects.Codegen/Schema/PostgresSchema.cs's
// CreateView. v1 supports:
//
//   * passthrough origin (no @via)  → plain column from the single base entity
//   * aggregate origin (@agg/@of/@via) → correlated subquery over a to-many
//
// Deferred to v2 (returns a "-- TODO" view that the runner skips applying):
//
//   * passthrough origin WITH @via  → to-one correlated subquery
//   * collection origin              → json_agg over a to-many
//   * multi-base projections         → blocked
//
// Identifiers are quoted throughout so mixed-case column names (e.g.
// "programId") survive PG's case-folding pass.

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  type ColumnNamingStrategy,
  MetaPassthroughOrigin,
  MetaAggregateOrigin,
  MetaCollectionOrigin,
  MetaSource,
  SOURCE_ROLE_PRIMARY,
  TYPE_OBJECT,
  TYPE_ORIGIN,
  resolveColumnName,
  resolveTableName,
  stripPackage,
} from "@metaobjectsdev/metadata";
import type { ViewDescriptor } from "./types.js";

export function buildExpectedViews(root: MetaRoot, strategy: ColumnNamingStrategy): ViewDescriptor[] {
  const out: ViewDescriptor[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_OBJECT) continue;
    const proj = child as MetaObject;
    if (proj.isAbstract) continue;
    if (!isReadOnlyProjection(proj)) continue;
    const view = buildView(proj, root, strategy);
    if (view !== null) out.push(view);
  }
  return out;
}

function isReadOnlyProjection(entity: MetaObject): boolean {
  const sources = entity.ownChildren().filter((c): c is MetaSource => c instanceof MetaSource);
  if (sources.length === 0) return false;
  const hasReadOnly = sources.some((s) => s.isReadOnly());
  const hasWritable = sources.some((s) => !s.isReadOnly());
  return hasReadOnly && !hasWritable;
}

function buildView(
  projection: MetaObject, root: MetaRoot, strategy: ColumnNamingStrategy,
): ViewDescriptor | null {
  const primarySource = projection.ownChildren().find(
    (c): c is MetaSource => c instanceof MetaSource && c.role === SOURCE_ROLE_PRIMARY,
  );
  // Use physicalName (FR-016 kind-aware), NOT tableName — a view-kind source names
  // itself via @view, and tableName reads ONLY the @table slot (undefined for views),
  // which previously bailed every @view projection here before any column was built.
  if (primarySource === undefined) return null;
  const viewName = primarySource.physicalName;

  const cols: string[] = [];
  let baseEntity: string | undefined;
  let blocked: string | undefined;
  const T = "t"; // target alias in correlated subqueries

  const baseTable = () => {
    if (baseEntity === undefined) return undefined;
    const found = root.findObject(baseEntity);
    return found ? resolveTableName(found) : baseEntity;
  };

  for (const f of projection.fields()) {
    const origin = f.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    const fieldCol = resolveColumnName(f, strategy);

    // FR-024 base-link: a projection field that uses `extends: Base.field` (instead of
    // an explicit origin) is an implicit passthrough — its source IS the extended field.
    // That linkage lives in EXTENDED metadata (superRef / resolveSuper()), which
    // f.ownChildren() cannot see, so without this an extends-based field (typically the
    // PK that declares the projection's base) falls through to "no resolvable origin" and
    // bails the whole view — taking the sibling origin.passthrough renames down with it.
    if (origin === undefined && f.superRef !== undefined && f.superRef.includes(".")) {
      const [ent, field] = splitDot(f.superRef);
      const bare = stripPackage(ent);
      baseEntity ??= bare;
      if (bare !== baseEntity) { blocked = "passthrough from multiple base entities"; break; }
      const srcEntity = root.findObject(baseEntity);
      const srcCol = resolveColumnByName(srcEntity, field, strategy);
      cols.push(`  "${srcCol}" AS "${fieldCol}"`);
      continue;
    }

    if (origin instanceof MetaPassthroughOrigin && origin.via === undefined &&
        origin.from !== undefined && origin.from.includes(".")) {
      const [ent, field] = splitDot(origin.from);
      const bare = stripPackage(ent);
      baseEntity ??= bare;
      if (bare !== baseEntity) { blocked = "passthrough from multiple base entities"; break; }
      const srcEntity = root.findObject(baseEntity);
      const srcCol = resolveColumnByName(srcEntity, field, strategy);
      cols.push(`  "${srcCol}" AS "${fieldCol}"`);
    } else if (origin instanceof MetaAggregateOrigin && origin.agg !== undefined &&
               origin.of !== undefined && origin.via !== undefined &&
               origin.of.includes(".") && origin.via.includes(".")) {
      const [baseEnt, relName] = splitDot(origin.via);
      const bareBase = stripPackage(baseEnt);
      baseEntity ??= bareBase;
      if (bareBase !== baseEntity) { blocked = "aggregate over a different base entity"; break; }
      const fk = resolveToManyFk(root, baseEntity, relName, strategy);
      if (fk === null) {
        blocked = `unresolved to-many FK for @via "${origin.via}" (target needs an identity.reference back to ${baseEntity})`;
        break;
      }
      const ofCol = resolveColumnByName(fk.target, splitDot(origin.of)[1], strategy);
      cols.push(
        `  (SELECT ${origin.agg}(${T}."${ofCol}") ` +
        `FROM "${fk.targetTable}" ${T} ` +
        `WHERE ${T}."${fk.fkCol}" = "${baseTable()}"."${fk.parentCol}") AS "${fieldCol}"`,
      );
    } else if (origin instanceof MetaPassthroughOrigin || origin instanceof MetaCollectionOrigin) {
      blocked = `field "${f.name}" uses an origin shape not yet supported by TS migrate-ts (passthrough-via / collection — deferred)`;
      break;
    } else {
      blocked = `field "${f.name}" has no resolvable origin`;
      break;
    }
  }

  if (blocked !== undefined || baseEntity === undefined || cols.length === 0) {
    // Caller decides what to do with a null result. For v1 the runner just
    // omits it from expected.views — diff sees no expected view, no
    // create-view change, and an actual leftover view (if any) gets dropped.
    return null;
  }

  const sql = `SELECT\n${cols.join(",\n")}\nFROM "${baseTable()}"`;
  const view: ViewDescriptor = { name: viewName, sql };
  return view;
}

function splitDot(s: string): [string, string] {
  const i = s.indexOf(".");
  return [s.slice(0, i), s.slice(i + 1)];
}

function resolveColumnByName(
  owner: MetaObject | undefined, fieldName: string, strategy: ColumnNamingStrategy,
): string {
  if (owner === undefined) return fieldName;
  const field = owner.fields().find((f) => f.name === fieldName);
  return field ? resolveColumnName(field, strategy) : fieldName;
}

interface ToManyFk {
  target: MetaObject;
  targetTable: string;
  /** Column on the target entity holding the FK back to the base. */
  fkCol: string;
  /** Column on the base entity the FK references (usually the base's PK). */
  parentCol: string;
}

function resolveToManyFk(
  root: MetaRoot, baseEntityName: string, relName: string, strategy: ColumnNamingStrategy,
): ToManyFk | null {
  const baseObj = root.findObject(baseEntityName);
  if (baseObj === undefined) return null;
  const rel = baseObj.relationships().find((r) => r.name === relName);
  if (rel === undefined || rel.objectRef === undefined) return null;
  const target = root.findObject(stripPackage(rel.objectRef));
  if (target === undefined) return null;

  const fkRef = target.referenceIdentities().find(
    (r) => r.targetEntity !== undefined && stripPackage(r.targetEntity) === baseEntityName,
  );
  if (fkRef === undefined) return null;
  const fkFields = fkRef.fields;
  if (fkFields.length === 0) return null;
  const fkCol = resolveColumnByName(target, fkFields[0]!, strategy);

  const parentFieldName = fkRef.targetFields.length > 0
    ? fkRef.targetFields[0]!
    : baseObj.primaryIdentity()?.fields[0];
  if (parentFieldName === undefined) return null;
  const parentCol = resolveColumnByName(baseObj, parentFieldName, strategy);

  return { target, targetTable: resolveTableName(target), fkCol, parentCol };
}

