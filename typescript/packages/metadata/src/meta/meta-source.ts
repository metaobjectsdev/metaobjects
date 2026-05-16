// MetaSource — concrete node class for type=source nodes.
// Declares where an object's data lives (Project E).
// dbTable / dbView source subtypes declare the SQL table or view name.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import { SOURCE_ATTR_NAME } from "../constants.js";

export class MetaSource extends MetaData {
  /** The SQL table or view name (value of @name attr on the source child). */
  get sourceName(): string | undefined {
    const v = this.attr(SOURCE_ATTR_NAME);
    return typeof v === "string" ? v : undefined;
  }
}
