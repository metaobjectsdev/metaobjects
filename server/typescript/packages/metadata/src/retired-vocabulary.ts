// server/typescript/packages/metadata/src/retired-vocabulary.ts
//
// Vocabulary this project USED to register, and what to do instead.
//
// WHY THIS EXISTS (#337). Under ADR-0023 the registry is strict and sealed, so retired
// vocabulary fails the load — correctly. But the message it failed with said the attribute
// was "not declared by any registered provider", which tells an author their metadata is
// malformed when the truth is that the vocabulary was retired ON PURPOSE, in a named
// release, with a written migration. An adopter read that error, concluded the tool had a
// registration bug, filed it as one, and argued against a decision whose reasoning they had
// never seen — because nothing in the error pointed at it. The migration guide answered
// their objection precisely. They never found it.
//
// THIS CHANGES NO LOAD OUTCOME. Retired vocabulary still fails, with the same error code,
// at the same site. Only the message gains a sentence. That is deliberate: making any of
// these load again would undo an adjudicated breaking change, and a "helpful" shim is how a
// retirement quietly stops being one.
//
// SCOPE IS BY TYPE, NEVER BY BARE NAME. `@unique` is retired on `identity.secondary` and
// perfectly live on a field; a name-only match would brand a valid declaration as retired,
// which is worse than the generic message it replaces. Every entry names the type it
// applies to, and `*` means "every subtype of this type" — never "every type".
//
// A GENUINE TYPO MUST STAY GENERIC. This map is consulted only after the normal check has
// already decided to fail, and it returns undefined for anything it does not recognise, so
// `@maxLenght` still reports as an unknown attribute. The map speaks only where it KNOWS.
//
// CROSS-PORT: this is a DIAGNOSTIC, not registered vocabulary — it affects no registry
// manifest and no load outcome, so it carries no registry-conformance obligation. The other
// four ports fail identically today, just with the generic message; mirroring this map is a
// per-port ergonomics follow-up, not a conformance gap.

/** What a reader needs at the moment their load fails. */
export interface RetirementNote {
  /** The release that retired it. */
  readonly since: string;
  /** One line: what it was, and why it went. */
  readonly why: string;
  /** The vocabulary that replaced it, when something did. */
  readonly replacedBy?: string;
  /** Repo-relative migration guide. */
  readonly migration?: string;
}

/**
 * The mechanical fix, when one exists.
 *
 * ABSENT MEANS JUDGMENT — `@status: abandoned` can be resolved by deleting the node, by
 * retyping it, or by fixing the residue it describes, and only a human knows which. A tool
 * that guessed would emit metadata that LOADS and means something different, which is worse
 * than refusing: the adopter would believe the migration finished.
 */
export type VocabularyRewrite =
  /** The attribute name changed; the value is untouched. */
  | { readonly kind: "renameAttr"; readonly to: string }
  /** The attribute went away with no replacement — drop it. */
  | { readonly kind: "dropAttr" }
  /** Both the name and the value changed (`@readOnly: true` → `@mutability: "readOnly"`). */
  | { readonly kind: "renameAttrValue"; readonly toAttr: string; readonly fromValue: unknown; readonly toValue: unknown };

/** One retirement. `subType: "*"` means every subtype of `type`. */
export interface RetiredEntry extends RetirementNote {
  readonly type: string;
  /** `*` for every subtype of `type`, else the exact subtype. */
  readonly subType: string;
  /** Retired ATTRIBUTE name (no `@`), when the attribute itself went. */
  readonly attr?: string;
  /** Retired VALUES of a surviving attribute, when only some members went. */
  readonly attrValues?: readonly string[];
  /** Set when the SUBTYPE itself was retired (`attr`/`attrValues` absent). */
  readonly isSubTypeRetirement?: boolean;
  /** How `meta upgrade` fixes it. Absent ⇒ the human decides; the tool refuses and
   *  prints `migration`. */
  readonly rewrite?: VocabularyRewrite;
}

const REQUIREMENT_MIGRATION = "docs/features/migrations/verified-by-retirement.md";

export const RETIRED_VOCABULARY: readonly RetiredEntry[] = [
  // ── 0.25.0: `@violation` is renamed `@counterexample` ──
  //
  // Pure rename — no semantics change. The field always held a static falsifiability test
  // ("what would contradict this"), authored once, never a state. `@violation` READ as a
  // status, and did so to the person who approved the vocabulary, who asked whether it
  // meant "we know this requirement is currently violated". A name that misleads its own
  // owner has earned replacing.
  //
  // Fully mechanical, which is the point: adopters migrate with `meta upgrade --apply`
  // rather than a hand sweep. This entry is the first real user of that tool.
  {
    type: "requirement", subType: "*", attr: "violation",
    since: "0.25.0",
    why: "it named a static falsifiability test but read as a status — 'this requirement " +
         "is in violation' — which is not what the field has ever held",
    replacedBy: "@counterexample",
    migration: "docs/features/migrations/violation-to-counterexample.md",
    rewrite: { kind: "renameAttr", to: "counterexample" },
  },

  // ── FR-038: the requirement vocabulary becomes prescriptive-only (0.24.0) ──
  {
    type: "requirement", subType: "*", attr: "verifiedBy",
    since: "0.24.0",
    why: "it asked you to name a test, and verify could only check that the NAME occurred " +
         "somewhere in your test sources — never that the named test verified the claim",
    migration: REQUIREMENT_MIGRATION,
    // Nothing replaced it, so the fix is removal. Safe to automate: the attribute drove no
    // behaviour anyone else can observe.
    rewrite: { kind: "dropAttr" },
  },
  {
    type: "requirement", subType: "*", attr: "supersededBy",
    since: "0.24.0",
    why: "a requirement is prescriptive — it states what should be true and is never a " +
         "journal of what happened",
    migration: REQUIREMENT_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
  {
    type: "requirement", subType: "*", attr: "status",
    attrValues: ["abandoned", "superseded"],
    since: "0.24.0",
    why: "retiring a capability is DELETING its requirement; version control holds that it " +
         "existed, and `notes` on a surviving entry holds what a reader still needs",
    migration: REQUIREMENT_MIGRATION,
  },

  // ── FR-037 R1: @readOnly becomes the @mutability enum (0.24.0) ──
  {
    type: "field", subType: "*", attr: "readOnly",
    since: "0.24.0",
    why: "a boolean could not express write-once, so the axis became an enum",
    replacedBy: "@mutability",
    migration: "docs/features/migrations/readonly-to-mutability.md",
    // Key AND value: `@readOnly: true` becomes `@mutability: "readOnly"`. Only the `true`
    // arm is mechanical — `@readOnly: false` was the default and simply goes away, which
    // the rewriter treats as a drop rather than inventing a mutability the author never
    // stated.
    rewrite: { kind: "renameAttrValue", toAttr: "mutability", fromValue: true, toValue: "readOnly" },
  },

  // ── FR-037 R2: origin.collection retires to reserved-not-registered (0.24.0) ──
  {
    type: "origin", subType: "collection", isSubTypeRetirement: true,
    since: "0.24.0",
    why: "it duplicated `origin.aggregate @agg: collect` on a strictly smaller attribute " +
         "set, and nothing dispatched on it",
    replacedBy: "origin.aggregate @agg: collect",
    migration: "docs/features/migrations/origin-collection-retirement.md",
  },

  // ── ADR-0040: uniqueness lives in the TYPE, not an attribute (0.15.1) ──
  {
    type: "identity", subType: "secondary", attr: "unique",
    since: "0.15.1",
    why: "`identity.secondary` is now always a unique alternate key — uniqueness is encoded " +
         "in the type, so the attribute had nothing left to say",
    replacedBy: "index.lookup (for a NON-unique retrieval index)",
    migration: "docs/features/migrations/identity-secondary-to-index-lookup.md",
  },

  // ── Metamodel 1.0: @dbColumnType slim-and-derive (0.15.0) ──
  {
    type: "field", subType: "*", attr: "dbColumnType",
    attrValues: ["uuid_array", "text_array"],
    since: "0.15.0",
    why: "array-ness is DERIVED from `isArray`, so an array-flavoured physical type restated " +
         "something the model already knew",
    replacedBy: "isArray: true on the field",
    // On a VALUE-scoped entry, `dropAttr` means "drop it when the value is one of the
    // retired ones" — never unconditionally. `@dbColumnType: jsonb` is live vocabulary on
    // the same attribute, and removing it would silently change the column type.
    //
    // Safe because the attribute said nothing the model did not already know: the field
    // carrying `uuid_array` necessarily has `isArray: true`, which is where array-ness now
    // comes from. There is no guide for this one, so without the rewrite an adopter would
    // be told it is retired and given nowhere to go — which is what the dead-end test that
    // caught this exists to prevent.
    rewrite: { kind: "dropAttr" },
  },
];

/** True when `entry` governs `typeKey` (`"<type>.<subType>"`). */
function scopeMatches(entry: RetiredEntry, typeKey: string): boolean {
  const dot = typeKey.indexOf(".");
  if (dot < 0) return false;
  const type = typeKey.slice(0, dot);
  const subType = typeKey.slice(dot + 1);
  if (entry.type !== type) return false;
  return entry.subType === "*" || entry.subType === subType;
}

function note(entry: RetiredEntry): RetirementNote {
  const out: RetirementNote = { since: entry.since, why: entry.why };
  return {
    ...out,
    ...(entry.replacedBy !== undefined ? { replacedBy: entry.replacedBy } : {}),
    ...(entry.migration !== undefined ? { migration: entry.migration } : {}),
  };
}

/**
 * The attribute NAME itself was retired for this type. Returns undefined for an attr whose
 * name is unknown here — a typo must keep reporting as a typo.
 *
 * An entry carrying `attrValues` is a VALUE retirement on a surviving attribute, so it is
 * deliberately not matched here: `@status` is still perfectly good vocabulary.
 */
export function retiredAttr(typeKey: string, attrName: string): RetirementNote | undefined {
  const hit = RETIRED_VOCABULARY.find(
    (e) => e.attr === attrName && e.attrValues === undefined && scopeMatches(e, typeKey),
  );
  return hit === undefined ? undefined : note(hit);
}

/** A specific VALUE of a surviving attribute was retired. */
export function retiredAttrValue(
  typeKey: string,
  attrName: string,
  value: unknown,
): RetirementNote | undefined {
  if (typeof value !== "string") return undefined;
  const hit = RETIRED_VOCABULARY.find(
    (e) => e.attr === attrName && e.attrValues?.includes(value) === true && scopeMatches(e, typeKey),
  );
  return hit === undefined ? undefined : note(hit);
}

/** The SUBTYPE itself was retired (`origin.collection`). */
export function retiredSubType(type: string, subType: string): RetirementNote | undefined {
  const hit = RETIRED_VOCABULARY.find(
    (e) => e.isSubTypeRetirement === true && e.type === type && e.subType === subType,
  );
  return hit === undefined ? undefined : note(hit);
}

/**
 * The sentence appended to a failing diagnostic. Kept here rather than at each call site so
 * all three failure sites word a retirement identically — an adopter who has seen one
 * recognises the next.
 */
export function retirementHint(n: RetirementNote): string {
  const parts = [`retired in ${n.since} — ${n.why}`];
  if (n.replacedBy !== undefined) parts.push(`Use ${n.replacedBy} instead.`);
  if (n.migration !== undefined) parts.push(`Migration: ${n.migration}.`);
  return parts.join(". ").replace(/\.\./g, ".");
}
