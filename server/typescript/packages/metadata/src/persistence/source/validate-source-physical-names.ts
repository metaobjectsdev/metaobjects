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

  for (const obj of root.ownChildren().filter((c) => c.type === TYPE_OBJECT)) {
    const sources = obj
      .ownChildren()
      .filter(
        (c): c is MetaSource =>
          c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_RDB && c instanceof MetaSource,
      );

    for (const source of sources) {
      const setAliases = ALL_PHYSICAL_NAME_ALIASES.filter((attr) => {
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
