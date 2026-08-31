// server/typescript/packages/metadata/src/retired-vocabulary.ts
//
// Vocabulary this project USED to register — or used to READ and document without ever
// registering — and what to do instead.
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
// ITS SIBLING IS `attr-contradictions.ts` — pairs of LIVE attributes that may not sit on one
// node. Same two consumers (the loader's diagnostic and the `meta upgrade` rewriter), same
// reason for existing; kept apart because a retirement matches ONE name while a contradiction
// matches a PAIR, and merging them would give every entry here fields it can never use.
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
  /**
   * True when `meta upgrade --apply` can make this edit itself.
   *
   * Carried on the NOTE, not just the entry, because the diagnostic is the only place an
   * adopter meets a retirement — and the difference between "run one command" and "this is
   * a judgement call" is the single most useful thing to tell them at that moment. Absent
   * ⇒ the human decides (see `VocabularyRewrite`).
   */
  readonly automated?: boolean;
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
  /**
   * Both the name and the value changed (`@readOnly: true` → `@mutability: "readOnly"`).
   *
   * `otherwise` is REQUIRED, and that is the point. The attribute is retired for EVERY
   * value it could hold, so an entry that names only the value it can rewrite has said
   * nothing about the rest — and the rewriter's only honest options are to drop them or to
   * refuse them. Leaving it implicit is how `@readOnly: false` came to be silently skipped:
   * the entry's prose said "treated as a drop", the code fell through to `continue`, and
   * `meta upgrade` exited 0 on a file that still would not load.
   */
  | {
      readonly kind: "renameAttrValue";
      readonly toAttr: string;
      readonly fromValue: unknown;
      readonly toValue: unknown;
      /** What happens to every value other than `fromValue`. */
      readonly otherwise: "drop" | "refuse";
    };

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
const RETIRED_STATUS_MIGRATION = "docs/features/migrations/retired-status-restore.md";
const EMIT_ATTR_MIGRATION = "docs/features/migrations/emit-attrs-to-generator-config.md";

export const RETIRED_VOCABULARY: readonly RetiredEntry[] = [
  // ── 0.24.0: `@violation` is renamed `@counterexample` ──
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
    since: "0.24.0",
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
  // (@supersededBy is NOT retired vocabulary. 0.24.0 deregistered it; FR-039 registers
  // it again on `retired` only, and this time it RESOLVES — which is what the
  // 2026-08-10 ruling asked for at point 4 and never got. An entry here would make
  // `meta upgrade` delete an attribute the loader now accepts.)
  // ── FR-039 (0.24.2): `abandoned` / `superseded` become `retired` ──
  //
  // These were retired in 0.24.0 on the rule that a requirement never journals what
  // happened, and `meta upgrade` REFUSED them because what becomes of a retired
  // capability's record was judgement. FR-039 restores the capability under a name
  // that states the standing rule rather than the history — `retired` means "this
  // must not be rebuilt" — so the edit is no longer a judgement call and the tool
  // can make it.
  //
  // TWO entries rather than one value-map, because the rewriter's `renameAttrValue`
  // carries a single `fromValue` and `attrValues` already scopes each occurrence to
  // the value it fires on. `otherwise` is therefore unreachable, and is `refuse` so
  // that a future third member cannot be silently dropped by this entry.
  //
  // `@implementedBy` on one of these is handled by ATTR_CONTRADICTIONS, not here —
  // it is a live attribute made illegal by a sibling's VALUE, which is a different
  // match shape. Both passes run in one `meta upgrade`, so a legacy entry carrying
  // both is fully repaired in a single run rather than rewritten into a file that
  // still will not load.
  {
    type: "requirement", subType: "*", attr: "status",
    attrValues: ["abandoned"],
    since: "0.24.2",
    why: "a retired capability is recorded as `retired`, which states the standing rule " +
         "(do not rebuild this) rather than narrating what happened to it",
    migration: RETIRED_STATUS_MIGRATION,
    rewrite: {
      kind: "renameAttrValue",
      toAttr: "status",
      fromValue: "abandoned",
      toValue: "retired",
      otherwise: "refuse",
    },
  },
  {
    type: "requirement", subType: "*", attr: "status",
    attrValues: ["superseded"],
    since: "0.24.2",
    why: "`superseded` was `retired` plus a pointer, and the pointer is @supersededBy — " +
         "which is registered again, and now RESOLVES",
    migration: RETIRED_STATUS_MIGRATION,
    rewrite: {
      kind: "renameAttrValue",
      toAttr: "status",
      fromValue: "superseded",
      toValue: "retired",
      otherwise: "refuse",
    },
  },

  // ── FR-037 R1: @readOnly becomes the @mutability enum (0.24.0) ──
  {
    type: "field", subType: "*", attr: "readOnly",
    since: "0.24.0",
    why: "a boolean could not express write-once, so the axis became an enum",
    replacedBy: "@mutability",
    migration: "docs/features/migrations/readonly-to-mutability.md",
    // Key AND value: `@readOnly: true` becomes `@mutability: "readOnly"`. `@readOnly: false`
    // was the default and simply goes away — hence `otherwise: "drop"` rather than inventing
    // a mutability the author never stated. Both arms must be stated: the attribute is
    // deregistered for every value, so an unhandled arm is a file that still fails to load
    // after a run that reported success.
    rewrite: {
      kind: "renameAttrValue",
      toAttr: "mutability",
      fromValue: true,
      toValue: "readOnly",
      otherwise: "drop",
    },
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
  // ── FR-040: the @emit* family leaves the model (0.24.6) ──
  //
  // Five attributes — @emitRoutes, @emitTanstack, @emitForm, @emitGrid, @emitAngular — were
  // READ by the TypeScript generators as per-entity kill switches, and documented as THE way
  // to suppress an artifact, but they were never REGISTERED by any provider. So they worked
  // under `meta gen`, which loads open, and failed `meta verify`, which loads strict: a
  // mechanism we documented broke the drift gate we documented beside it.
  //
  // They are retired rather than registered. codegen-ts's own constants file already called
  // them "NOT metamodel vocabulary — they tune codegen, not the model" and then read them off
  // metadata anyway; that contradiction is the defect, and ADR-0023 §2 names the class.
  // Registering them instead would move `metamodelVersion` and oblige four other ports to
  // carry a TypeScript-only generator flag none of them will ever read.
  //
  // WHAT REPLACED THEM IS CONFIGURATION, NOT VOCABULARY, so `replacedBy` names a mechanism
  // rather than an attribute — the only entries here that do. The rule is one sentence:
  // decide per generator what you consume, wire only the generators whose output you import,
  // and narrow one with its own `filter`.
  //
  // `dropAttr` is safe for all five: after this release nothing reads them, so removing one
  // cannot change what is emitted. What it DOES change is what `meta gen` emitted BEFORE —
  // an adopter who suppressed an artifact this way now gets that artifact — which is why the
  // run also warns by name, rather than letting the file appear with no explanation.
  {
    type: "object", subType: "*", attr: "emitRoutes",
    since: "0.24.6",
    why: "it was never registered vocabulary, so the opt-out we documented passed `meta gen` " +
         "and failed `meta verify`",
    replacedBy: "the routes generator's own `filter` — routesFile({ filter: (e) => … })",
    migration: EMIT_ATTR_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
  {
    type: "object", subType: "*", attr: "emitTanstack",
    since: "0.24.6",
    why: "it was never registered vocabulary, so the opt-out we documented passed `meta gen` " +
         "and failed `meta verify`",
    replacedBy: "the `filter` option on tanstackQuery() / tanstackGrid() / tanstackGridHook()",
    migration: EMIT_ATTR_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
  {
    type: "object", subType: "*", attr: "emitForm",
    since: "0.24.6",
    why: "it was never registered vocabulary, and its own doc comment described it backwards " +
         "— as opt-IN via `true`, while the code implemented opt-OUT via `false`",
    replacedBy: "formFile({ filter: (e) => … })",
    migration: EMIT_ATTR_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
  {
    type: "object", subType: "*", attr: "emitAngular",
    since: "0.24.6",
    why: "it was never registered vocabulary, and unlike its four siblings it was not even a " +
         "named constant — just a bare string literal in four generators",
    replacedBy: "the `filter` option on the Angular generators",
    migration: EMIT_ATTR_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
  {
    // The one that is opt-IN rather than opt-out, so `filter` cannot replace it: a filter is
    // ANDed with the built-in gates and can only ever narrow. It became a generator OPTION,
    // which must be passed to BOTH grid generators — they emit a matched pair of files.
    type: "object", subType: "*", attr: "emitGrid",
    since: "0.24.6",
    why: "it was never registered vocabulary, and being an opt-IN it could not be expressed " +
         "by a generator filter, which only ever narrows",
    replacedBy: "the `tphSubtypeGrids` option on BOTH tanstackGrid() and tanstackGridHook()",
    migration: EMIT_ATTR_MIGRATION,
    rewrite: { kind: "dropAttr" },
  },
];


/**
 * True when `entry` governs `typeKey` (`"<type>.<subType>"`).
 *
 * Exported because the rewriter scopes every occurrence with the SAME rule. It used to
 * carry its own copy, and a scoping rule that lives in two files is one that will be fixed
 * in one of them.
 */
export function scopeMatches(entry: RetiredEntry, typeKey: string): boolean {
  const dot = typeKey.indexOf(".");
  if (dot < 0) return false;
  if (entry.type !== typeKey.slice(0, dot)) return false;
  return entry.subType === "*" || entry.subType === typeKey.slice(dot + 1);
}

/** The reader-facing half of an entry, without the matching machinery. */
export function note(entry: RetiredEntry): RetirementNote {
  return {
    since: entry.since,
    why: entry.why,
    ...(entry.replacedBy !== undefined ? { replacedBy: entry.replacedBy } : {}),
    ...(entry.migration !== undefined ? { migration: entry.migration } : {}),
    ...(entry.rewrite !== undefined ? { automated: true } : {}),
  };
}

/** First entry satisfying `match`, as a note. The three lookups below differ only in it. */
function noted(match: (e: RetiredEntry) => boolean): RetirementNote | undefined {
  const hit = RETIRED_VOCABULARY.find(match);
  return hit === undefined ? undefined : note(hit);
}

/**
 * The attribute NAME itself was retired for this type. Returns undefined for an attr whose
 * name is unknown here — a typo must keep reporting as a typo.
 *
 * An entry carrying `attrValues` is a VALUE retirement on a surviving attribute, so it is
 * deliberately not matched here: `@status` is still perfectly good vocabulary.
 */
export function retiredAttr(typeKey: string, attrName: string): RetirementNote | undefined {
  return noted(
    (e) => e.attr === attrName && e.attrValues === undefined && scopeMatches(e, typeKey),
  );
}

/** A specific VALUE of a surviving attribute was retired. */
export function retiredAttrValue(
  typeKey: string,
  attrName: string,
  value: unknown,
): RetirementNote | undefined {
  if (typeof value !== "string") return undefined;
  return noted(
    (e) => e.attr === attrName && e.attrValues?.includes(value) === true && scopeMatches(e, typeKey),
  );
}

/** The SUBTYPE itself was retired (`origin.collection`). */
export function retiredSubType(type: string, subType: string): RetirementNote | undefined {
  return noted((e) => e.isSubTypeRetirement === true && e.type === type && e.subType === subType);
}

/**
 * The sentence appended to a failing diagnostic. Kept here rather than at each call site so
 * all three failure sites word a retirement identically — an adopter who has seen one
 * recognises the next.
 */
export function retirementHint(n: RetirementNote): string {
  // Sentences are built WITHOUT their terminator and punctuated once at the end. The
  // previous form appended a period to each fragment and then repaired the doubling with a
  // global `".." → "."` — which would silently rewrite an ellipsis, or a `../` in a
  // migration path, inside the user-facing load error.
  const parts = [`retired in ${n.since} — ${n.why}`];
  if (n.replacedBy !== undefined) parts.push(`Use ${n.replacedBy} instead`);
  if (n.migration !== undefined) parts.push(`Migration: ${n.migration}`);
  return `${parts.join(". ")}.`;
}

/**
 * The ADR-0009 `suggestions[]` for a retirement: what to DO, as distinct from
 * `retirementHint`, which says what happened.
 *
 * WHY THIS EXISTS. A caller that knows only "the load failed with ERR_UNKNOWN_ATTR" gives
 * the generic three exits — register the attr, stash it in an `attr.properties` bag, or
 * re-run with `--lax`. For a TYPO that is exactly right. For a RETIREMENT the middle one is
 * actively harmful: the properties bag is exempt from the strict-attr check, so it loads,
 * and the value then sits there reaching nothing. The adopter gets a green `meta verify`
 * over metadata that no longer means what they wrote — a loud, correct failure converted
 * into a quiet, wrong pass. So a retirement supplies its own exits and the caller prints
 * those instead of guessing.
 */
export function retirementSuggestions(n: RetirementNote): string[] {
  const out: string[] = [];
  if (n.automated === true) out.push("Run `meta upgrade --apply` to make this edit for you.");
  if (n.replacedBy !== undefined) out.push(`Use ${n.replacedBy} instead.`);
  if (n.migration !== undefined) out.push(`Migration guide: ${n.migration}`);
  // Never the `attr.properties` bag: it would load, and mean nothing. See above.
  return out;
}
