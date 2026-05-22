import {
  TYPE_SOURCE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
} from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";

function hasSource(entity: MetaData, subType: string): boolean {
  return entity.ownChildren().some(
    (c) => c.type === TYPE_SOURCE && c.subType === subType,
  );
}

export function isProjection(entity: MetaData): boolean {
  return (
    hasSource(entity, SOURCE_SUBTYPE_DB_VIEW) &&
    !hasSource(entity, SOURCE_SUBTYPE_DB_TABLE)
  );
}

export function isWriteThrough(entity: MetaData): boolean {
  return (
    hasSource(entity, SOURCE_SUBTYPE_DB_VIEW) &&
    hasSource(entity, SOURCE_SUBTYPE_DB_TABLE)
  );
}
