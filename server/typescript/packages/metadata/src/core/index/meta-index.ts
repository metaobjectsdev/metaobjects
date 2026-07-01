// MetaIndex — concrete node class for type=index nodes.
// MetaLookupIndex is the single concrete subtype class.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  INDEX_SUBTYPE_LOOKUP,
  INDEX_ATTR_FIELDS,
} from "./index-constants.js";

export class MetaIndex extends MetaData {
  /** ADR-0039: resolving — @fields may be inherited via extends. */
  fields(): string[] {
    const f = this.attr(INDEX_ATTR_FIELDS);
    return Array.isArray(f) ? (f as string[]) : [];
  }

  isLookup(): boolean {
    return this.subType === INDEX_SUBTYPE_LOOKUP;
  }
}
