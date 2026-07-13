import type { Change, AllowOptions } from "../types.js";
import { isWidening } from "../sql-type.js";
import { DEFAULT_DB_SCHEMA_POSTGRES } from "@metaobjectsdev/metadata";

/**
 * A view's identity is (schema, name) — NOT the bare name. Keying the recreate-pair
 * exemption on the name alone let a same-named view in a DIFFERENT schema inherit the
 * exemption: an expected `reporting.summary` being rebuilt (create-view) would un-gate a
 * destructive DROP of an unmodeled, hand-written `public.summary`. Normalize the absent
 * schema to the postgres default so expected (often undefined) compares equal to
 * introspected (always populated).
 */
function viewIdentity(name: string, schema: string | undefined): string {
  return (schema ?? DEFAULT_DB_SCHEMA_POSTGRES) + "." + name;
}

/**
 * Mutates each Change's `status` field per the rules in spec §6.5.
 * Destructive/lossy changes default to blocked unless the corresponding
 * `allow.*` flag is set.
 */
export function applyStatus(changes: Change[], allow: AllowOptions = {}): void {
  // A drop-view paired with a create-view/replace-view for the SAME view in this
  // change list is the diff's internal recreate around a column-altering change
  // (Pass 2c) — the view survives the migration, so it is not a destructive drop
  // and must not require allow.dropView. Only an unpaired drop-view (the view is
  // gone from the model, or was never modeled) is a real removal.
  const recreatedViews = new Set<string>();
  for (const c of changes) {
    if (c.kind === "create-view" || c.kind === "replace-view") {
      recreatedViews.add(viewIdentity(c.view.name, c.schema));
    }
  }
  for (const c of changes) {
    const blockedReason = blockedReasonFor(c, allow, recreatedViews);
    if (blockedReason !== null) {
      c.status = { state: "blocked", blockedReason };
    } else {
      c.status = { state: "allowed" };
    }
  }
}

function blockedReasonFor(
  c: Change,
  allow: AllowOptions,
  recreatedViews: ReadonlySet<string>,
): string | null {
  switch (c.kind) {
    case "drop-column":
      return allow.dropColumn ? null : "destructive: drop-column not allowed (pass allow.dropColumn)";
    case "drop-table":
      return allow.dropTable ? null : "destructive: drop-table not allowed (pass allow.dropTable)";
    case "drop-index":
      return allow.dropIndex ? null : "destructive: drop-index not allowed (pass allow.dropIndex)";
    case "drop-fk":
      return allow.dropFk ? null : "destructive: drop-fk not allowed (pass allow.dropFk)";
    case "drop-check":
      return allow.dropCheck ? null : "destructive: drop-check not allowed (pass allow.dropCheck)";
    case "drop-view": {
      // A drop that would destroy relations we do NOT manage is gated INDEPENDENTLY of
      // whether our own view survives. Even the recreate pair — where our view comes
      // back — cascades through to somebody else's dependent view and destroys it for
      // good, and this tool cannot restore what it does not manage. So check dependents
      // FIRST: it is the one thing `allow.dropView` must never be able to wave through.
      const external = c.dependents ?? [];
      if (external.length > 0 && !allow.dropViewCascade) {
        return `destructive: dropping view "${c.view}" would CASCADE into ${external.length} object(s) `
          + `MetaObjects does not manage and cannot restore `
          + `(${external.map((d) => `${d.schema}.${d.name}`).join(", ")}) `
          + `— pass allow.dropViewCascade to destroy them, or migrate them off this view first`;
      }
      // Identity, not bare name — see viewIdentity().
      if (recreatedViews.has(viewIdentity(c.view, c.schema))) return null; // recreate pair — view survives
      return allow.dropView ? null : "destructive: drop-view not allowed (pass allow.dropView)";
    }

    case "replace-view":
      // The DB view carries no MetaObjects fingerprint, so it is either hand-written or
      // predates fingerprinting — and Postgres deparses view SQL, so the two are
      // indistinguishable. Overwriting a hand-written view destroys SQL no down
      // migration can recover, so fail closed and make the operator say yes.
      //
      // Every environment upgrading from a pre-fingerprint toolchain hits this exactly
      // once, then its views are stamped and it never fires again.
      if (c.unmanagedActual && !allow.adoptView) {
        return `existing view "${c.view.name}" carries no MetaObjects fingerprint — it is hand-written, `
          + `or was created before view fingerprinting. Overwriting it takes ownership and cannot be undone. `
          + `Pass allow.adoptView to adopt it`;
      }
      return null;

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
    case "create-view":
      return null;
  }
}
