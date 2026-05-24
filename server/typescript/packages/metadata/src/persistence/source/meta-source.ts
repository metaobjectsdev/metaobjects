// MetaSource — concrete node class for type=source nodes.
// Declares where an object's data lives (Project E).
// dbTable / dbView source subtypes declare the SQL table or view name (v1).
// source.rdb (v2) uses @table/@kind/@role/@schema; read-only is derived from @kind.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  SOURCE_ATTR_NAME,
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_READ_ONLY_KINDS,
  DEFAULT_SOURCE_KIND,
  DEFAULT_SOURCE_ROLE,
} from "./source-constants.js";

export class MetaSource extends MetaData {
  /** The SQL table or view name (value of @name attr on the source child). */
  get sourceName(): string | undefined {
    const v = this.ownAttr(SOURCE_ATTR_NAME);
    return typeof v === "string" ? v : undefined;
  }

  /** Physical SQL table/view name from @table (source.rdb / v2). */
  get tableName(): string | undefined {
    const v = this.ownAttr(SOURCE_ATTR_TABLE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /**
   * The effective kind for this source.
   * For source.rdb: the value of @kind, defaulting to "table" when omitted.
   * For v1 subtypes (dbTable/dbView): @kind is not registered, so ownAttr
   * returns undefined → defaults to "table".
   */
  get effectiveKind(): string {
    const v = this.ownAttr(SOURCE_ATTR_KIND);
    return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_KIND;
  }

  /** The multi-source role for this source (defaults to "primary" when omitted). */
  get role(): string {
    const v = this.ownAttr(SOURCE_ATTR_ROLE);
    return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_ROLE;
  }

  /**
   * True when this source's effective kind is read-only (view, materializedView,
   * storedProc, tableFunction).  For source.rdb this is @kind-derived. V1
   * dbView sources carry no @kind so they default to "table" (writable) under
   * this implementation; they are handled by a later migration task.
   */
  isReadOnly(): boolean {
    return SOURCE_READ_ONLY_KINDS.has(this.effectiveKind);
  }

  /** True when this source is writable (i.e. not read-only). */
  isWritable(): boolean {
    return !this.isReadOnly();
  }
}
