// MetaSource — concrete node class for type=source nodes.
// Declares where an object's data lives (Project E).
// dbTable / dbView source subtypes declare the SQL table or view name.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  SOURCE_ATTR_NAME,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
} from "../constants.js";

export class MetaSource extends MetaData {
  /** The SQL table or view name (value of @name attr on the source child). */
  get sourceName(): string | undefined {
    const v = this.ownAttr(SOURCE_ATTR_NAME);
    return typeof v === "string" ? v : undefined;
  }

  /**
   * True when this source is a `dbTable` (writable).
   * Explicitly defined rather than derived from `isReadOnly()` so it remains
   * correct if a third source subtype is added in the future.
   */
  isWritable(): boolean {
    return this.subType === SOURCE_SUBTYPE_DB_TABLE;
  }

  /**
   * True when this source is a `dbView` (read-only projection).
   * Explicitly defined rather than derived from `isWritable()` so it remains
   * correct if a third source subtype is added in the future.
   */
  isReadOnly(): boolean {
    return this.subType === SOURCE_SUBTYPE_DB_VIEW;
  }
}
