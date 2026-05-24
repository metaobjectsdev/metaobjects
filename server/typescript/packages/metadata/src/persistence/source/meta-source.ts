// MetaSource — concrete node class for type=source nodes.
// Declares where an object's data lives (Project E).
// source.rdb uses @table/@kind/@role/@schema; read-only is derived from @kind.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_READ_ONLY_KINDS,
  DEFAULT_SOURCE_KIND,
  DEFAULT_SOURCE_ROLE,
} from "./source-constants.js";

export class MetaSource extends MetaData {
  /** Physical SQL table/view name from @table (source.rdb). */
  get tableName(): string | undefined {
    const v = this.ownAttr(SOURCE_ATTR_TABLE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /**
   * The effective kind for this source: the value of `@kind`, defaulting to
   * `"table"` when omitted (ADR-0007 Rule 3 — per-paradigm default).
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
   * storedProc, tableFunction). Derived from the @kind attr on source.rdb.
   */
  isReadOnly(): boolean {
    return SOURCE_READ_ONLY_KINDS.has(this.effectiveKind);
  }

  /** True when this source is writable (i.e. not read-only). */
  isWritable(): boolean {
    return !this.isReadOnly();
  }
}
