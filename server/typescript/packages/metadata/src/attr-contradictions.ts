// server/typescript/packages/metadata/src/attr-contradictions.ts
//
// Pairs of LIVE attributes that may not both be declared on one node — and, where the
// resolution is mechanical, which one `meta upgrade` drops.
//
// THE SIBLING OF `retired-vocabulary.ts`, DELIBERATELY NOT PART OF IT. That table answers
// "this name is gone"; this one answers "both these names are fine, and together they are
// not". The match shape differs (one attribute versus a pair on the same node), the fix
// shape differs (rewrite a value versus delete one of two), and folding them together
// would give every retirement entry fields it can never use. They share the thing that
// matters instead: both are consulted by the LOADER for its diagnostic and by the
// `meta upgrade` rewriter for its fix, so the message an adopter reads and the edit the
// tool makes come from one place and cannot drift apart.
//
// WHY A MECHANICAL FIX IS AVAILABLE HERE AT ALL, when `@status: abandoned` is refused.
// A refusal is right when the correct edit depends on intent nobody recorded. It is wrong
// when the metadata's own history says what the declaration MEANT. `@fields` + `@expr`
// loaded before 0.24.1 and `@fields` was silently DISCARDED — `migrate-ts` has always run
// `columns: expr ? [] : cols`, so the index in the adopter's database is the expression
// one. Dropping `@fields` therefore reproduces the object that already exists; keeping
// `@fields` and dropping `@expr` would invent a different index and emit a migration
// against live data. There is one answer, and the deployed schema is the evidence for it.
//
// CROSS-PORT: like the retirement map this is a DIAGNOSTIC plus a TS-only fixer. It
// changes no load OUTCOME — every port already refuses the contradiction with the same
// code — and the shared corpus compares error code and source, never message text. So it
// carries no registry-conformance obligation; mirroring it is per-port ergonomics.

/**
 * One pair of attributes that may not co-occur on a node.
 *
 * `drop` and `keep` are named for the REWRITE, not for importance: an entry exists only
 * where one side is provably redundant. An entry with no mechanical answer does not belong
 * here — it belongs in the loader alone, refusing.
 */
export interface AttrContradiction {
  readonly type: string;
  /** `*` for every subtype of `type`, else the exact subtype. */
  readonly subType: string;
  /** Declared alongside `keep`, this one goes. Matched on PRESENCE — see below. */
  readonly drop: string;
  /** The attribute whose presence makes `drop` illegal, and which survives the rewrite. */
  readonly keep: string;
  /**
   * When set, `keep` makes `drop` illegal only at THESE values — the pair is a
   * contradiction of meaning rather than of mere co-occurrence.
   *
   * It lists every spelling that has ever carried the meaning, across the version
   * boundary, and that is load-bearing rather than defensive: the rewriter runs the
   * contradiction pass BEFORE the retirement pass, so a legacy document still says
   * `abandoned` at the moment this is evaluated. Listing only the modern value would
   * make `meta upgrade --apply` rewrite the status, leave the contradicting sibling
   * behind, and exit 0 on a file that still does not load — the exact failure #342
   * was filed for.
   */
  readonly keepValues?: readonly string[];
  /** The release that started refusing the pair. */
  readonly since: string;
  /** One line stating the RULE, in the present tense — the loader has already said WHICH
   *  node broke it, so this says what the rule is. */
  readonly why: string;
  /** What the rewrite costs, completing "so <effect>" — the sentence that tells an adopter
   *  it is safe to run, and why the answer is not a guess. */
  readonly effect: string;
}

export const ATTR_CONTRADICTIONS: readonly AttrContradiction[] = [
  // ── FR-039: a retired requirement has no implementation (0.24.2) ──
  //
  // The pair is @status: retired + @implementedBy. It is a contradiction of MEANING,
  // not of co-occurrence — @status and @implementedBy sit together happily on every
  // other status — which is why this is the first entry needing `keepValues`.
  //
  // Mechanical, and the reason it is: a retired capability has no implementation BY
  // DEFINITION, so the reference list describes nodes that are gone. That is not a
  // judgement call about what the author meant; it is what retiring something IS. The
  // record of what used to implement it belongs in `notes` (the shape one adopting
  // estate reached by hand before any ruling, on the grounds that "what used to
  // implement a retired capability is real information in the wrong field") and what
  // REPLACED it belongs in @supersededBy, which resolves.
  {
    type: "requirement", subType: "*",
    drop: "implementedBy", keep: "status",
    keepValues: ["retired", "abandoned", "superseded"],
    since: "0.24.2",
    why: "a retired requirement has no implementation — that is what retiring it means",
    effect: "the references named nodes that are gone, so dropping them removes a list " +
            "nothing could resolve; what REPLACED the capability goes in @supersededBy " +
            "and why it went goes in `notes`",
  },
  // ── #342: an index key is @fields XOR @expr (0.24.1) ──
  //
  // Both subtypes, because ADR-0040 puts uniqueness in the TYPE: `identity.secondary` IS a
  // unique index, keys itself identically, and carries `@expr` from the same db provider.
  // `identity.primary` and `identity.reference` are absent on purpose — a primary key or an
  // FK is always plain columns and has no `@expr` to contradict.
  {
    type: "index", subType: "lookup",
    drop: "fields", keep: "expr",
    since: "0.24.1",
    why: "an index keys off plain columns (@fields) or a key expression (@expr), never both",
    effect: "the index in your database is the expression one and dropping @fields " +
            "changes no emitted DDL",
  },
  {
    type: "identity", subType: "secondary",
    drop: "fields", keep: "expr",
    since: "0.24.1",
    why: "a unique key keys off plain columns (@fields) or a key expression (@expr), never both",
    effect: "the constraint in your database is the expression one and dropping @fields " +
            "changes no emitted DDL",
  },
];

/** True when `c` governs `typeKey` (`"<type>.<subType>"`). Mirrors `scopeMatches`. */
export function contradictionScopeMatches(c: AttrContradiction, typeKey: string): boolean {
  const dot = typeKey.indexOf(".");
  if (dot < 0) return false;
  if (c.type !== typeKey.slice(0, dot)) return false;
  return c.subType === "*" || c.subType === typeKey.slice(dot + 1);
}

/** Every contradiction governing this type key. */
export function contradictionsFor(typeKey: string): readonly AttrContradiction[] {
  return ATTR_CONTRADICTIONS.filter((c) => contradictionScopeMatches(c, typeKey));
}

/**
 * The sentence appended to the load error that refuses the pair.
 *
 * Kept beside the table for the reason #337 recorded: an adopter who is told only that
 * their metadata is invalid concludes the tool is broken, because nothing in the message
 * says a fixer exists. Naming the command is the difference between a dead end and a
 * one-line migration.
 */
export function contradictionHint(c: AttrContradiction): string {
  return (
    `${c.why} — drop one. Declaring both previously loaded but silently discarded ` +
    `@${c.drop}, so ${c.effect}. \`meta upgrade --apply\` drops it for you.`
  );
}
