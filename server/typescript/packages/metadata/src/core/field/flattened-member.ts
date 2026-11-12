// A path into a member of a FLATTENED value object (`address.city`): the
// member's column lives on the owning table, under the embedding field's prefix
// (resolveFlattenedColumnName). One resolver for the loader and every lowering.

import type { MetaData } from "../../shared/meta-data.js";
import { TYPE_FIELD } from "../../shared/base-types.js";
import { refTarget } from "../../naming-refs.js";
import { resolveColumnName, resolveFlattenedColumnName, type ColumnNamingStrategy } from "../../naming.js";
import { FIELD_ATTR_OBJECT_REF, FIELD_ATTR_STORAGE, FIELD_SUBTYPE_OBJECT, STORAGE_FLATTENED } from "./field-constants.js";

/** A flattened member path, resolved: the embedding field on the entity and the member on its value object. */
export interface FlattenedMember {
  readonly embedding: MetaData;
  readonly member: MetaData;
}

/**
 * Resolve `<field>.<member>` against `entity`: `<field>` a scalar `field.object` with
 * `@storage: flattened`, `<member>` a field its `@objectRef` value object declares (effective).
 * Undefined for anything else — a plain field name, a jsonb object, an array, an unknown member.
 * One level: a value object flattened inside another is not addressed this way.
 */
export function resolveFlattenedMember(entity: MetaData, path: string): FlattenedMember | undefined {
  const dot = path.indexOf(".");
  if (dot < 1 || dot === path.length - 1 || path.indexOf(".", dot + 1) !== -1) return undefined;
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  // Effective children: the embedding field may be inherited via extends.
  const embedding = entity.children().find((c) => c.type === TYPE_FIELD && c.name === head);
  if (embedding === undefined || embedding.subType !== FIELD_SUBTYPE_OBJECT) return undefined;
  // ADR-0039: resolving — @storage / @objectRef may be inherited via extends.
  if (embedding.attr(FIELD_ATTR_STORAGE) !== STORAGE_FLATTENED) return undefined;
  const vo = refTarget(embedding, FIELD_ATTR_OBJECT_REF);
  if (vo === undefined) return undefined;
  const member = vo.children().find((c) => c.type === TYPE_FIELD && c.name === tail);
  return member === undefined ? undefined : { embedding, member };
}

/**
 * The physical column a field PATH names on `entity` — a plain field
 * (`countryId`, effective) or a flattened member (`address.countryId`, the embedding's prefix
 * plus the member's column). An `identity.reference @fields` entry may be either, so every
 * consumer of reference columns (view joins, `meta migrate`'s foreign keys) resolves through
 * here. Undefined when the path names neither.
 */
export function resolveFieldPathColumn(
  entity: MetaData,
  path: string,
  strategy?: ColumnNamingStrategy,
): string | undefined {
  const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === path);
  if (field !== undefined) return resolveColumnName(field, strategy);
  const flattened = resolveFlattenedMember(entity, path);
  return flattened === undefined ? undefined : resolveFlattenedColumnName(flattened.embedding, flattened.member, strategy);
}
