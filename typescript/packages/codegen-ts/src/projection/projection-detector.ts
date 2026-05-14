import {
  TYPE_SOURCE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
} from "@metaobjects/metadata";
import type { MetaModel } from "@metaobjects/metadata";

function hasSource(entity: MetaModel, subType: string): boolean {
  return entity.children().some(
    (c) => c.type === TYPE_SOURCE && c.subType === subType,
  );
}

export function isProjection(entity: MetaModel): boolean {
  return (
    hasSource(entity, SOURCE_SUBTYPE_DB_VIEW) &&
    !hasSource(entity, SOURCE_SUBTYPE_DB_TABLE)
  );
}

export function isWriteThrough(entity: MetaModel): boolean {
  return (
    hasSource(entity, SOURCE_SUBTYPE_DB_VIEW) &&
    hasSource(entity, SOURCE_SUBTYPE_DB_TABLE)
  );
}
