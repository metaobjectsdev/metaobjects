import type { Change, AllowOptions, ColumnDefault } from "../types.js";
import { isWidening } from "../sql-type.js";
import { dropsAutoSequenceDefault } from "../pg-identity-default.js";
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
    const block = blockFor(c, allow, recreatedViews);
    c.status = block !== null ? { state: "blocked", ...block } : { state: "allowed" };
  }
}

/** Why a change is blocked, and the one `AllowOptions` field that lifts that block. */
interface Block {
  blockedBy: keyof AllowOptions;
  blockedReason: string;
}

/** Null when `allow[blockedBy]` is granted, else the block naming it. */
function gate(allow: AllowOptions, blockedBy: keyof AllowOptions, blockedReason: string): Block | null {
  return allow[blockedBy] ? null : { blockedBy, blockedReason };
}

function blockFor(
  c: Change,
  allow: AllowOptions,
  recreatedViews: ReadonlySet<string>,
): Block | null {
  switch (c.kind) {
    case "drop-column":
      return gate(allow, "dropColumn", "destructive: drop-column not allowed (pass allow.dropColumn)");
    case "drop-table":
      return gate(allow, "dropTable", "destructive: drop-table not allowed (pass allow.dropTable)");
    case "drop-index":
      // Carried through a rename-column: the same rule over the same data — nothing is lost.
      if (c.carriedByRename === true) return null;
      return gate(allow, "dropIndex", "destructive: drop-index not allowed (pass allow.dropIndex)");
    case "drop-fk":
      // Carried through a rename-column: the same rule over the same data — nothing is lost.
      if (c.carriedByRename === true) return null;
      return gate(allow, "dropFk", "destructive: drop-fk not allowed (pass allow.dropFk)");
    case "drop-check":
      // Carried through a rename-column: the same rule over the same data — nothing is lost.
      if (c.carriedByRename === true) return null;
      // Re-spelled for older SQLite: the same rule comes straight back.
      if (c.respelled === true) return null;
      return gate(allow, "dropCheck", "destructive: drop-check not allowed (pass allow.dropCheck)");
    case "drop-view": {
      // A drop that would destroy relations we do NOT manage is gated INDEPENDENTLY of
      // whether our own view survives. Even the recreate pair — where our view comes
      // back — cascades through to somebody else's dependent view and destroys it for
      // good, and this tool cannot restore what it does not manage. So check dependents
      // FIRST: it is the one thing `allow.dropView` must never be able to wave through.
      const external = c.dependents ?? [];
      if (external.length > 0 && !allow.dropViewCascade) {
        return {
          blockedBy: "dropViewCascade",
          blockedReason: `destructive: dropping view "${c.view}" would CASCADE into ${external.length} object(s) `
            + `MetaObjects does not manage and cannot restore `
            + `(${external.map((d) => `${d.schema}.${d.name}`).join(", ")}) `
            + `— pass allow.dropViewCascade to destroy them, or migrate them off this view first`,
        };
      }
      // #239: the drop half of ADOPTING an unmanaged view (no fingerprint) whose shape
      // changed too much for a legal CREATE OR REPLACE. It is paired with a create-view,
      // so the recreate-pair rule below would auto-allow it — but clobbering (possibly
      // hand-written) SQL needs explicit consent, exactly like the replace-view adopt
      // path. Gate on allow.adoptView BEFORE the recreate-pair auto-allow.
      if (c.unmanagedActual && !allow.adoptView) {
        return {
          blockedBy: "adoptView",
          blockedReason: `existing view "${c.view}" carries no MetaObjects fingerprint — it is hand-written, `
            + `or was created before view fingerprinting. Its shape changed, so adopting it means `
            + `DROP + rebuild, which takes ownership and cannot be undone. Pass allow.adoptView to adopt it`,
        };
      }
      // Identity, not bare name — see viewIdentity().
      if (recreatedViews.has(viewIdentity(c.view, c.schema))) return null; // recreate pair — view survives
      return gate(allow, "dropView", "destructive: drop-view not allowed (pass allow.dropView)");
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
        return {
          blockedBy: "adoptView",
          blockedReason: `existing view "${c.view.name}" carries no MetaObjects fingerprint — it is hand-written, `
            + `or was created before view fingerprinting. Overwriting it takes ownership and cannot be undone. `
            + `Pass allow.adoptView to adopt it`,
        };
      }
      return null;

    case "change-column-type": {
      // A type change carries its column's default change (types.ts), so the one gated
      // default shape (see change-column-default below) is gated here as well.
      const refusal = autoSequenceDropRefusal(c.table, c.column, c.fromDefault, c.toDefault, allow);
      if (refusal !== null) return refusal;
      if (isWidening(c.from, c.to)) return null;     // widening always allowed
      return gate(allow, "typeChange", "lossy type change (pass allow.typeChange)");
    }

    case "change-column-nullable":
      // from = actual.nullable, to = expected.nullable
      // notnull (false) → nullable (true): allowed
      // nullable (true) → notnull (false): requires flag (existing data must satisfy)
      if (c.from === false && c.to === true) return null;
      return gate(allow, "nullableToNotNull", "nullable→notnull requires existing data to satisfy (pass allow.nullableToNotNull)");

    case "change-column-default": {
      // Ordinary default changes (literal→literal, adding/removing a plain
      // literal default, etc.) stay allowed unconditionally — only ONE narrow
      // shape is gated here. `to === undefined` means the default is being
      // DROPPED outright (see the ColumnDefault comment in types.ts), and
      // when what's being dropped is a live Postgres auto-sequence default
      // (`nextval(...)`, the shape a legacy `serial`/`bigserial` PK carries —
      // isPgAutoSequenceDefault, shared with diff/index.ts and the
      // introspector), reaching this point means the expected side declared
      // NO identity at all: an `identity: "increment"` expected column never
      // gets here, because diff/index.ts's skipIdentityDefaultDiff already
      // suppressed the change for that exact live shape. So an undeclared
      // `@generation` is the ONLY way this branch fires — and that silence is
      // ambiguous (never-declared vs. deliberately-removed), so ask rather
      // than guess. Anything else about change-column-default — including
      // dropping a plain literal default — falls through to the unconditional
      // `return null` below.
      return autoSequenceDropRefusal(c.table, c.column, c.from, c.to, allow);
    }

    case "change-column-identity":
      // Dropping an identity leaves the column with no generation mechanism: every insert
      // that omits it starts failing, the same hazard as dropping an auto-sequence default.
      if (c.to === "increment") return null;
      return gate(allow, "dropIdentityDefault", `column "${c.table}"."${c.column}" is a live Postgres identity column `
        + `but its metadata declares no @generation. Dropping the identity is destructive (every insert that omits `
        + `the column starts failing). Declare @generation: increment on the identity to keep it, or pass `
        + `--allow drop-identity-default if removing it is intentional`);

    case "change-comment":
      if (c.from === undefined || c.to !== undefined) return null;
      return gate(allow, "dropComment", `${c.column !== undefined ? `column "${c.table}"."${c.column}"` : `table "${c.table}"`} `
        + `has a comment its metadata does not declare. Clearing it cannot be undone. Declare it as the `
        + `description, or pass --allow drop-comment to clear it`);

    // Always-allowed kinds
    case "create-table":
    case "rename-table":
    case "add-column":
    case "rename-column":
    case "add-index":
    case "add-fk":
    case "add-check":
    case "create-view":
      return null;
  }
}

/**
 * Dropping a live Postgres auto-sequence default (`nextval(...)`) while the metadata declares
 * no identity is ambiguous, so it is refused unless allowed. Shared by `change-column-default`
 * and `change-column-type`, which carries its column's default change.
 */
function autoSequenceDropRefusal(
  table: string, column: string, from: ColumnDefault | undefined, to: ColumnDefault | undefined,
  allow: AllowOptions,
): Block | null {
  if (!dropsAutoSequenceDefault(from, to)) return null;
  return gate(allow, "dropIdentityDefault", `column "${table}"."${column}" has a live Postgres auto-increment default `
    + `(${from!.value}) but its metadata declares no @generation — this is ambiguous: it `
    + `could mean @generation was never declared, or that auto-increment is being removed on `
    + `purpose. Dropping the default is destructive (every insert that omits the column starts `
    + `failing), so this refuses rather than guessing. Declare @generation: increment on the `
    + `identity to keep the sequence, or pass --allow drop-identity-default if removing it is `
    + `intentional`);
}
