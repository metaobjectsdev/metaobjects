// Validation pass: DDL-ownership escape valves (#208) — @sql / @unmanaged on
// source.rdb. Sibling of validate-source-roles.ts / validate-source-physical-names.ts.
//
// #208 gives source.rdb two mutually exclusive, non-default DDL-ownership
// markers: @sql (a hand-written body the tool registers/fingerprints/drift-
// checks but never authors) and @unmanaged (this object's DDL is owned
// elsewhere — the tool never touches it). This pass enforces the six
// fail-closed rules from the design doc (§5):
//
//   R1  @sql AND @unmanaged on the SAME source          → ERR_SQL_BODY_WITH_UNMANAGED
//   R2  @sql on a writable @kind ("table", the default)  → ERR_SQL_BODY_ON_WRITABLE_KIND
//   R3  @sql present but empty / whitespace-only         → ERR_BAD_ATTR_VALUE
//   R4  origin.*-bearing field under an @sql host         → ERR_ORIGIN_UNDER_SQL_BODY
//   R5  object.projection @filter (#207) + @sql host      → ERR_ORIGIN_UNDER_SQL_BODY
//   R6  origin.*-bearing field under an @unmanaged host    → WARN_ORIGIN_UNDER_UNMANAGED
//
// R1–R3 are per-source (declaration-layer). R4–R6 are per-host-object: a host
// with ANY own source.rdb carrying @sql/@unmanaged is judged against its own
// fields (and, for R5, its own @filter). The asymmetry between R4 (hard error)
// and R6 (warn) is deliberate (design doc §5.6): @sql is a second body (two
// sources of truth for the SAME data); @unmanaged acts on nothing, so a
// documented-but-unacted-on lineage is benign.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import type { LoaderWarning } from "../../source.js";
import { TYPE_OBJECT, TYPE_SOURCE, TYPE_FIELD } from "../../shared/base-types.js";
import { OBJECT_SUBTYPE_PROJECTION, OBJECT_PROJECTION_ATTR_FILTER } from "../../core/object/object-constants.js";
import { MetaSource } from "./meta-source.js";
import { MetaField } from "../../core/field/meta-field.js";
import { SOURCE_ATTR_SQL, SOURCE_SUBTYPE_RDB } from "./source-constants.js";

export interface SourceEscapeValidationResult {
  errors: ParseError[];
  warnings: LoaderWarning[];
}

export function validateSourceEscapes(root: MetaData): SourceEscapeValidationResult {
  const errors: ParseError[] = [];
  const warnings: LoaderWarning[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: own — declaration-layer source iteration (mirrors validateSourceRoles /
    // validateSourceParameterRef): R1–R3 judge markers DECLARED on this object's own sources.
    const sources = obj
      .ownChildren()
      .filter(
        (c): c is MetaSource =>
          c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_RDB && c instanceof MetaSource,
      );

    let hasSqlHost = false;
    let hasUnmanagedHost = false;

    for (const source of sources) {
      // ADR-0039: resolving — @sql/@unmanaged are inheritable (follow the
      // @role/effectiveKind precedent — sources are inheritable, NOT the
      // @dbColumnType own-only exception).
      const sqlSet = source.sqlBody !== undefined;
      const unmanagedSet = source.isUnmanaged;

      // R1 — contradictory DDL owners on the same source.
      if (sqlSet && unmanagedSet) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" declares both @sql and @unmanaged — these are the ` +
              `mutually exclusive non-default states of one DDL-ownership axis (an author-supplied body ` +
              `contradicts "someone else owns this DDL")`,
            { code: "ERR_SQL_BODY_WITH_UNMANAGED", source: source.source },
          ),
        );
      }

      // R2 — @sql on a writable kind would bypass the column-diff machinery;
      // tables are fully modeled or @unmanaged, never opaque-bodied.
      if (sqlSet && source.isWritable()) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" declares @sql with a writable @kind ("${source.effectiveKind}") — ` +
              `@sql is legal only on a read-only kind (view/materializedView/storedProc/tableFunction); ` +
              `a writable table is either fully modeled or marked @unmanaged, never opaque-bodied`,
            { code: "ERR_SQL_BODY_ON_WRITABLE_KIND", source: source.source },
          ),
        );
      }

      // R3 — @sql present but empty/whitespace. MUST read the raw attr, not
      // the sqlBody accessor: sqlBody already narrows an empty string to
      // undefined, which would make a present-but-empty @sql indistinguishable
      // from an absent one.
      const rawSql = source.attr(SOURCE_ATTR_SQL);
      if (rawSql !== undefined && (typeof rawSql !== "string" || rawSql.trim() === "")) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" sets @sql to an empty/whitespace-only value; ` +
              `@sql requires a non-empty SQL body`,
            { code: "ERR_BAD_ATTR_VALUE", source: source.source },
          ),
        );
      }

      if (sqlSet) hasSqlHost = true;
      if (unmanagedSet) hasUnmanagedHost = true;
    }

    if (!hasSqlHost && !hasUnmanagedHost) continue;

    // R4 / R6 — origin.*-bearing (derived) own fields under an @sql / @unmanaged
    // host. ADR-0039: own — origin.* never inherits (ADR-0029), so isDerived()
    // is own-only by policy (mirrors validateDerivedFieldProvidability).
    // @sql (hard error) takes priority over @unmanaged (warn) when a host
    // happens to declare both markers across different sources.
    for (const field of obj.ownChildren().filter((c): c is MetaField => c.type === TYPE_FIELD && c instanceof MetaField)) {
      if (!field.isDerived()) continue;
      if (hasSqlHost) {
        errors.push(
          new ParseError(
            `field "${obj.name}.${field.name}" carries an origin.* (derived) child, but "${obj.name}" has a ` +
              `read source carrying @sql — the synthesized derivation and the author's verbatim SQL are two ` +
              `sources of truth for the same body`,
            { code: "ERR_ORIGIN_UNDER_SQL_BODY", source: field.source },
          ),
        );
      } else {
        warnings.push({
          code: "WARN_ORIGIN_UNDER_UNMANAGED",
          message:
            `field "${obj.name}.${field.name}" carries an origin.* (derived) child, but "${obj.name}" has a ` +
            `source marked @unmanaged — the tool never touches this object's DDL, so the derivation is ` +
            `documented lineage only (not acted on); this is informational, not an error`,
          source: field.source,
        });
      }
    }

    // R5 — a projection's row-scope @filter (#207) lowers to the outer WHERE
    // of a TOOL-SYNTHESIZED body; with @sql the author owns the body (and its
    // WHERE), so wrapping it is deferred cleverness (design doc D5) — reject.
    if (hasSqlHost && obj.subType === OBJECT_SUBTYPE_PROJECTION) {
      // ADR-0039: own — the @filter is declared locally on this projection
      // (mirrors validateProjectionFilter).
      const filter = obj.ownAttr(OBJECT_PROJECTION_ATTR_FILTER);
      if (filter !== undefined) {
        errors.push(
          new ParseError(
            `projection "${obj.name}" declares both @filter and an @sql read source — a view-level @filter ` +
              `lowers to the outer WHERE of a synthesized body; with @sql the author owns the body (and its ` +
              `WHERE), so the two cannot be combined`,
            { code: "ERR_ORIGIN_UNDER_SQL_BODY", source: obj.source },
          ),
        );
      }
    }
  }

  return { errors, warnings };
}
