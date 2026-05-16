// MetaAttr — concrete node class for type=attr nodes.
// Used when an attribute is materialized as a child node (rare).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import { RESERVED_KEY_VALUE } from "../constants.js";

export class MetaAttr extends MetaData {
  get value(): unknown {
    return this.attr(RESERVED_KEY_VALUE);
  }
}
