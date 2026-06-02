// MetaRelationship — concrete node class for type=relationship nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_THROUGH,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  RELATIONSHIP_ATTR_SYMMETRIC,
  RELATIONSHIP_ATTR_ON_DELETE,
  RELATIONSHIP_ATTR_ON_UPDATE,
} from "./relationship-constants.js";

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

  /** Junction (through) entity name for M:N relationships. */
  get through(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_THROUGH);
    return typeof v === "string" ? v : undefined;
  }

  /** Source-side FK field on the junction (directed self-join disambiguator). */
  get sourceRefField(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
    return typeof v === "string" ? v : undefined;
  }

  /** Whether this M:N relationship is an undirected (symmetric) self-join. */
  get symmetric(): boolean {
    return this.ownAttr(RELATIONSHIP_ATTR_SYMMETRIC) === true;
  }

  /** Referential action on parent delete. Undefined when not explicitly set (default derives from subtype). */
  get onDelete(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_ON_DELETE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /** Referential action on key update. Undefined when not explicitly set (default: cascade). */
  get onUpdate(): string | undefined {
    const v = this.ownAttr(RELATIONSHIP_ATTR_ON_UPDATE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }
}
