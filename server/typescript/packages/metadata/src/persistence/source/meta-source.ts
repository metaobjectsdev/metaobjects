// MetaSource — concrete node class for type=source nodes.
// Declares where an object's data lives (Project E).
// source.rdb uses kind-aware physical-name aliases + @kind/@role/@schema;
// read-only-ness is derived from @kind.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "../../shared/meta-data.js";
import { pluralize, toSnakeCase } from "../../naming.js";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_ROLE,
  SOURCE_ATTR_SQL,
  SOURCE_ATTR_UNMANAGED,
  SOURCE_READ_ONLY_KINDS,
  DEFAULT_SOURCE_KIND,
  DEFAULT_SOURCE_ROLE,
  PHYSICAL_NAME_ATTR_BY_KIND,
} from "./source-constants.js";

/** Every kind-aware physical-name alias key, ordered for deterministic
 *  iteration (matches the SOURCE_RDB_KINDS order). */
const ALL_PHYSICAL_NAME_ALIASES = [
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
] as const;

export class MetaSource extends MetaData {
  /** Physical SQL table/view name from the legacy @table attr. Kept as a
   *  back-compat accessor that reads ONLY the @table slot — callers should
   *  use physicalName for the FR-016 four-step rule. */
  get tableName(): string | undefined {
    // ADR-0039: resolving — a source may be inherited via extends (an entity
    // extending BaseEntity inherits its source.rdb); @table can live on the super.
    const v = this.attr(SOURCE_ATTR_TABLE);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /**
   * The effective kind for this source: the value of `@kind`, defaulting to
   * `"table"` when omitted (ADR-0007 Rule 3 — per-paradigm default).
   */
  get effectiveKind(): string {
    // ADR-0039: resolving — an inherited source's @kind lives on the super node.
    const v = this.attr(SOURCE_ATTR_KIND);
    return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_KIND;
  }

  /** The multi-source role for this source (defaults to "primary" when omitted). */
  get role(): string {
    // ADR-0039: resolving — an inherited source's @role lives on the super node.
    const v = this.attr(SOURCE_ATTR_ROLE);
    return typeof v === "string" && v !== "" ? v : DEFAULT_SOURCE_ROLE;
  }

  /**
   * FR-024/#208 — the hand-written SQL body for this source's DB object, when
   * declared via `@sql`. The tool registers + fingerprints + drift-checks this
   * body but never authors or parses it.
   */
  get sqlBody(): string | undefined {
    // ADR-0039: resolving — an inherited source's @sql lives on the super node.
    const v = this.attr(SOURCE_ATTR_SQL);
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  /**
   * FR-024/#208 — true when this source's DB object is managed elsewhere
   * (Flyway / a hand-migration owns its DDL); `meta migrate` does not
   * create/drop/drift-check it.
   */
  get isUnmanaged(): boolean {
    // ADR-0039: resolving — an inherited source's @unmanaged lives on the super node.
    return this.attr(SOURCE_ATTR_UNMANAGED) === true;
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

  /**
   * Resolved physical SQL name for this source, following the FR-016 / ADR-0018
   * four-step rule:
   *   1. Kind-matching alias (e.g. @proc when @kind: "storedProc").
   *   2. Legacy @table for non-table kind (pre-1.0 fallback).
   *   3. Source's bare structural `name` via snake_case.
   *   4. Owning entity's name via pluralize(snake_case).
   *
   * Callers needing the legacy raw @table slot only should use `tableName`;
   * codegen / migrate / runtime should use `physicalName`.
   */
  get physicalName(): string {
    const kind = this.effectiveKind;

    // Step 1: kind-matching alias.
    const canonicalAttr = PHYSICAL_NAME_ATTR_BY_KIND.get(kind);
    if (canonicalAttr !== undefined) {
      // ADR-0039: resolving — an inherited source's physical-name alias lives on the super.
      const v = this.attr(canonicalAttr);
      if (typeof v === "string" && v !== "") return v;
    }

    // Step 2: legacy @table for non-table kind.
    if (canonicalAttr !== SOURCE_ATTR_TABLE) {
      // ADR-0039: resolving — inherited @table lives on the super node.
      const legacy = this.attr(SOURCE_ATTR_TABLE);
      if (typeof legacy === "string" && legacy !== "") return legacy;
    }

    // Step 3: source's structural `name` via snake_case (no pluralization —
    // the source's name IS the logical name).
    if (this.name !== "") {
      return toSnakeCase(this.name);
    }

    // Step 4: owning entity's name via pluralize(snake_case). The MetaData
    // parent of a source is always the entity that declared it.
    const owner = this.parent;
    if (owner !== undefined && owner.name !== "") {
      return pluralize(toSnakeCase(owner.name));
    }

    return "";
  }
}
