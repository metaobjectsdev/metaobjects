// MetaRelationship — concrete node class for type=relationship nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
} from "../constants.js";

export class MetaRelationship extends MetaData {
  get cardinality(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
    return typeof v === "string" ? v : undefined;
  }

  /** FQN of the target object (e.g., "acme::vehicle::Car"). */
  get objectRef(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF);
    return typeof v === "string" ? v : undefined;
  }

  /** Name of the FK field on the source entity (for one-to-many / many-to-one). */
  get fkField(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_FK_FIELD);
    return typeof v === "string" ? v : undefined;
  }

  /** Join-table entity name for N:M relationships. */
  get joinEntity(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_JOIN_ENTITY);
    return typeof v === "string" ? v : undefined;
  }

  /** Join-table column names for N:M relationships. */
  get joinFields(): string[] {
    const f = this.ownAttr(RELATIONSHIP_ATTR_JOIN_FIELDS);
    return Array.isArray(f) ? (f as string[]) : [];
  }
}
