// MetaAttr — concrete node class for type=attr nodes.
// Used when an attribute is materialized as a child node (rare).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import { type DataType, type DataTypeAware, DATA_TYPE_STRING } from "../data-type.js";
import { RESERVED_KEY_VALUE } from "../constants.js";

export class MetaAttr extends MetaData implements DataTypeAware {
  get value(): unknown {
    return this.ownAttr(RESERVED_KEY_VALUE);
  }

  /** The coarse value-type classification for this attribute's subtype. */
  get dataType(): DataType {
    return this._dataType ?? DATA_TYPE_STRING;
  }
}
