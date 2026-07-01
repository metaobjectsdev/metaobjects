// Validation pass: per-kind physical-name aliases on source.rdb (FR-016 / ADR-0018).
//
// Each source.rdb may declare at most one of @table / @view / @materializedView /
// @proc / @function. The chosen alias must match the source's @kind, with one
// pre-1.0 legacy exception: @table is also accepted for non-table kinds (e.g.
// @kind: "storedProc" + @table: "fn_x"), which emits a WARN_LEGACY_PHYSICAL_NAME_ALIAS.
//
// Codes:
//   ERR_PHYSICAL_NAME_MULTIPLE      — two or more kind-aware aliases on one source.
//   ERR_PHYSICAL_NAME_KIND_MISMATCH — alias other than @table set with a non-matching @kind.
//   WARN_LEGACY_PHYSICAL_NAME_ALIAS — @table set with a non-table @kind (legacy spelling).

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import type { LoaderWarning } from "../../source.js";
import { TYPE_OBJECT, TYPE_SOURCE } from "../../shared/base-types.js";
import { MetaSource } from "./meta-source.js";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
  SOURCE_SUBTYPE_RDB,
  PHYSICAL_NAME_ATTR_BY_KIND,
} from "./source-constants.js";

const ALL_PHYSICAL_NAME_ALIASES = [
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
] as const;

export interface PhysicalNameValidationResult {
  errors: ParseError[];
  warnings: LoaderWarning[];
}

export function validateSourcePhysicalNames(root: MetaData): PhysicalNameValidationResult {
  const errors: ParseError[] = [];
  const warnings: LoaderWarning[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    // ADR-0039: own — validates the physical-name aliases DECLARED on this object's
    // own sources (declaration-layer, mirrors validateSourceRoles); an inherited
    // source's aliases were validated on the object that declares it.
    const sources = obj
      .ownChildren()
      .filter(
        (c): c is MetaSource =>
          c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_RDB && c instanceof MetaSource,
      );

    for (const source of sources) {
      // Empty-string check first — explicit "" is meaningless and an
      // authoring error regardless of which alias was used.
      for (const attr of ALL_PHYSICAL_NAME_ALIASES) {
        // ADR-0039: own — the "exactly one alias, non-empty" rule is a per-source
        // OWN-declaration constraint (resolving would conflate an inherited alias
        // with an own one and falsely trip ERR_PHYSICAL_NAME_MULTIPLE).
        const v = source.ownAttr(attr);
        if (typeof v === "string" && v === "") {
          errors.push(
            new ParseError(
              `source.rdb on object "${obj.name}" sets @${attr} to an empty string; physical name attrs require a non-empty value`,
              { code: "ERR_BAD_ATTR_VALUE", source: source.source },
            ),
          );
        }
      }

      const setAliases = ALL_PHYSICAL_NAME_ALIASES.filter((attr) => {
        // ADR-0039: own — per-source own-declaration constraint (see above).
        const v = source.ownAttr(attr);
        return typeof v === "string" && v !== "";
      });

      if (setAliases.length > 1) {
        errors.push(
          new ParseError(
            `source.rdb on object "${obj.name}" declares multiple physical-name aliases (${setAliases
              .map((a) => `@${a}`)
              .join(", ")}); set exactly one`,
            { code: "ERR_PHYSICAL_NAME_MULTIPLE", source: source.source },
          ),
        );
        continue;
      }

      if (setAliases.length === 0) continue;

      const chosenAlias = setAliases[0]!;
      const expectedAlias = PHYSICAL_NAME_ATTR_BY_KIND.get(source.effectiveKind);

      if (chosenAlias === expectedAlias) continue;

      // Legacy: @table is permitted for non-table kinds with a warning.
      if (chosenAlias === SOURCE_ATTR_TABLE) {
        warnings.push({
          code: "WARN_LEGACY_PHYSICAL_NAME_ALIAS",
          message:
            `source.rdb on object "${obj.name}" uses @table with @kind: "${source.effectiveKind}"; ` +
            `prefer the kind-matching alias @${expectedAlias} (ADR-0018)`,
          source: source.source,
        });
        continue;
      }

      // Any other mismatch is a hard error.
      errors.push(
        new ParseError(
          `source.rdb on object "${obj.name}" uses @${chosenAlias} with @kind: "${source.effectiveKind}"; ` +
            `@${chosenAlias} is only valid for @kind: "${kindForAlias(chosenAlias)}"`,
          { code: "ERR_PHYSICAL_NAME_KIND_MISMATCH", source: source.source },
        ),
      );
    }
  }

  return { errors, warnings };
}

function kindForAlias(alias: string): string {
  for (const [kind, attr] of PHYSICAL_NAME_ATTR_BY_KIND.entries()) {
    if (attr === alias) return kind;
  }
  return "(unknown)";
}
