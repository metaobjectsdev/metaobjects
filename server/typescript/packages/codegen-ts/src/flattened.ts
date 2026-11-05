// `field.object @storage: flattened` — the one place codegen-ts decides what a flattened value
// object looks like in the Drizzle table and in the schemas that validate its writes.
//
// The columns are the ones `meta migrate` creates: one per member of the value object, named
// by core naming (`resolveFlattenedColumnName`), and none for the field itself. The generated
// surface is FLAT, the same surface the Prisma generator exposes: each member is a key
// `<field><Member>` (`shipToStreet`) on the Drizzle table, the Row/Insert types, the Zod
// schemas and the filter allowlist.

import {
  isMetaObject,
  refTarget,
  resolveFlattenedColumnName,
  physicalNamingOf,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_MUTABILITY,
  MUTABILITY_READ_ONLY,
  MUTABILITY_WRITE_ONCE,
  fieldMutability,
  STORAGE_FLATTENED,
  type MetaField,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy } from "./metaobjects-config.js";
import { hasWritableRdbSource } from "./source-detect.js";
import { tphDiscriminatorBase, tphStorageObject } from "./tph.js";

export interface FlattenedMember {
  /** The value object's own field. */
  readonly member: MetaField;
  /** The member presented under its flat key: what the schemas, types and codec names are derived from. */
  readonly flat: MetaField;
  /** The key of the member on the flat surface: `shipToStreet`. */
  readonly key: string;
  /** The member's column in the database: `ship_to_street`. */
  readonly column: string;
}

function upperFirst(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** True for a `field.object` whose storage is `flattened` (ADR-0039: resolving read). */
export function isFlattenedObjectField(field: MetaField): boolean {
  return field.subType === FIELD_SUBTYPE_OBJECT && field.attr(FIELD_ATTR_STORAGE) === STORAGE_FLATTENED;
}

/** The members of a flattened field, or undefined when it is not flattened (or names no value object). */
export function flattenedMembersOf(field: MetaField, strategy: ColumnNamingStrategy): FlattenedMember[] | undefined {
  if (!isFlattenedObjectField(field)) return undefined;
  const valueObject = refTarget(field, FIELD_ATTR_OBJECT_REF);
  if (valueObject === undefined || !isMetaObject(valueObject)) return undefined;
  // ADR-0039: effective fields — members inherited via extends are columns too (as migrate does).
  return valueObject.fields().map((member) => {
    const key = field.name + upperFirst(member.name);
    return { member, flat: asFlatKey(member, key, field), key, column: resolveFlattenedColumnName(field, member, strategy) };
  });
}

const MUTABILITY_TIGHTNESS = [MUTABILITY_READ_ONLY, MUTABILITY_WRITE_ONCE] as const;

/**
 * A member field presented under its flat key: it behaves as the value object's own field in
 * every way (subtype, attributes, validators) except that its `name` is `<field><Member>`,
 * which is what the Zod schema and the filter allowlist key it by, and that the write
 * protection of the flattened `parent` (`@mutability`, `@formExclude`) applies to every member.
 */
function asFlatKey(member: MetaField, key: string, parent: MetaField): MetaField {
  const attr = (name: string): unknown => {
    if (name === FIELD_ATTR_FORM_EXCLUDE && parent.attr(FIELD_ATTR_FORM_EXCLUDE) === true) return true;
    if (name === FIELD_ATTR_MUTABILITY) {
      const modes = [fieldMutability(parent), fieldMutability(member)];
      return MUTABILITY_TIGHTNESS.find((mode) => modes.includes(mode)) ?? member.attr(name);
    }
    return member.attr(name);
  };
  return new Proxy(member, {
    get(target, prop) {
      if (prop === "name") return key;
      if (prop === "attr") return attr;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * `obj.fields()` as the flat surface sees them: each flattened `field.object` replaced by its
 * members, keyed `<field><Member>`. Identical to `obj.fields()` for an object with none.
 *
 * Only a table-backed object flattens: a value object has no table, so a flattened field it
 * declares is nested jsonb when embedded. A field a TPH subtype declares beyond its base is
 * folded into the shared table as one jsonb column (`meta migrate` does not expand it), so it
 * stays a single key too.
 */
export function flatSurfaceFields(obj: MetaObject): MetaField[] {
  if (!hasWritableRdbSource(tphStorageObject(obj))) return obj.fields();
  const strategy = physicalNamingOf(obj).columns;
  const tphBase = tphDiscriminatorBase(obj);
  const baseFieldNames = tphBase === undefined ? undefined : new Set(tphBase.fields().map((f) => f.name));
  return obj.fields().flatMap((f) => {
    if (baseFieldNames !== undefined && !baseFieldNames.has(f.name)) return [f];
    const members = flattenedMembersOf(f, strategy);
    return members === undefined ? [f] : members.map((m) => m.flat);
  });
}
