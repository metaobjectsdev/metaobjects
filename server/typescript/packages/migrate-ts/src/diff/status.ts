import type { Change, AllowOptions } from "../types.js";
import { isWidening } from "../sql-type.js";

/**
 * Mutates each Change's `status` field per the rules in spec §6.5.
 * Destructive/lossy changes default to blocked unless the corresponding
 * `allow.*` flag is set.
 */
export function applyStatus(changes: Change[], allow: AllowOptions = {}): void {
  for (const c of changes) {
    const blockedReason = blockedReasonFor(c, allow);
    if (blockedReason !== null) {
      c.status = { state: "blocked", blockedReason };
    } else {
      c.status = { state: "allowed" };
    }
  }
}

function blockedReasonFor(c: Change, allow: AllowOptions): string | null {
  switch (c.kind) {
    case "drop-column":
      return allow.dropColumn ? null : "destructive: drop-column not allowed (pass allow.dropColumn)";
    case "drop-table":
      return allow.dropTable ? null : "destructive: drop-table not allowed (pass allow.dropTable)";
    case "drop-index":
      return allow.dropIndex ? null : "destructive: drop-index not allowed (pass allow.dropIndex)";
    case "drop-fk":
      return allow.dropFk ? null : "destructive: drop-fk not allowed (pass allow.dropFk)";

    case "change-column-type":
      if (isWidening(c.from, c.to)) return null;     // widening always allowed
      return allow.typeChange ? null : "lossy type change (pass allow.typeChange)";

    case "change-column-nullable":
      // from = actual.nullable, to = expected.nullable
      // notnull (false) → nullable (true): allowed
      // nullable (true) → notnull (false): requires flag (existing data must satisfy)
      if (c.from === false && c.to === true) return null;
      return allow.nullableToNotNull ? null : "nullable→notnull requires existing data to satisfy (pass allow.nullableToNotNull)";

    // Always-allowed kinds
    case "create-table":
    case "rename-table":
    case "add-column":
    case "rename-column":
    case "change-column-default":
    case "add-index":
    case "add-fk":
    case "add-check":
    case "drop-check":
    case "create-view":
    case "drop-view":
    case "replace-view":
      return null;
  }
}
