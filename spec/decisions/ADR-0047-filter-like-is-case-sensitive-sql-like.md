# ADR-0047: The `like` filter operator is case-sensitive SQL LIKE, uniformly

## Status

**Accepted** (2026-08-10). Pins the semantics of the `like` member of the
FR-008/FR-009 cross-port filter-operator contract (`eq, ne, gt, gte, lt, lte,
in, like, isNull`). Resolves the "cross-port `like` semantics contradict each
other" known-issue recorded in the 0.21.5 release notes.

## Context

The nine-operator REST filter contract shipped with `like` behaving
differently per port — and the shared conformance corpora could not see it:

- **TypeScript** (HTTP tier, `runtime-ts` `parseFilterParams` — every Fastify
  and Hono mount, both lanes of the api-contract corpus' generated servers)
  dispatched **ILIKE on Postgres** and native LIKE on SQLite — i.e.
  case-insensitive on both (SQLite's built-in LIKE folds ASCII case by
  default).
- **TypeScript** (persistence tier — the Kysely, Drizzle and in-memory
  `ObjectManager` drivers) emitted **verbatim case-sensitive LIKE**, the
  in-memory driver even documenting "SQL LIKE: … case-sensitive". The
  reference implementation disagreed with itself, tier to tier.
- **Python** (`ObjectManager` and both api-contract lanes) emitted plain
  case-sensitive `LIKE`, under a comment claiming it "mirrors TS".
- **C#** shipped case-sensitive `EF.Functions.Like` in the product dispatch
  (`EfCoreFilterDispatch`) while its own persistence-conformance adapter
  reflected Npgsql's **ILike** — the gate tested semantics the product never
  had.
- **Java** (OMDB) gained a verbatim case-sensitive `Expression.LIKE` in
  0.21.4; **Kotlin** (Exposed) was always case-sensitive LIKE.

Nothing caught this because both corpora were blind **by construction**: the
api-contract `filter-like` scenario probed `A%` against all-capitalized seed
names, and the persistence `filter-like-and-ne` fixture carried a comment
saying its data is case-aligned "so the test passes whether a port wires LIKE
or ILIKE".

The written record, however, was not silent:

- FR-009 §2 defines `like` as "SQL `LIKE` semantics — `%` wildcard".
- FR-009 §7 lists **"Case-insensitive `like` (`ilike`)"** as explicitly out of
  scope — "consumer post-processes if needed".
- ADR-0036 reserves `ilike` among the deliberately-not-added additive filter
  operators for post-1.0.

## Decision

1. **`like` is case-sensitive SQL LIKE**: the author-supplied pattern binds
   verbatim (no `%`-wrapping, no case folding), with `%` (any run) and `_`
   (any single character) as the only wildcards. This is uniform across all
   five ports and across engines.
2. **Engines whose native LIKE is not case-sensitive must be lowered around,
   not deferred to.** SQLite's built-in LIKE folds ASCII case by default and
   `PRAGMA case_sensitive_like` is connection-global on a consumer-owned
   connection, so the TS runtime lowers the sqlite branch to **GLOB** with an
   exactly-translated pattern (`%`→`*`, `_`→`?`; GLOB's own metacharacters
   `*`, `?`, `[` escaped as single-character classes). Behavior — not SQL
   spelling — is the contract.
3. **Case-insensitive matching stays out of the operator vocabulary** until a
   shipping consumer needs it, per the ADR-0037 decision procedure and the
   ADR-0036 reservation. It is additive whenever demand arrives (an `ilike`
   operator or an attribute-gated variant); pinning `like` sensitive today
   forecloses nothing. The reverse pin would: an insensitive `like` makes
   case-sensitive matching inexpressible over the wire, permanently.
4. **The TS-only `?search` extension remains deliberately case-insensitive**
   (ILIKE on Postgres; SQLite native LIKE). It is a human search box, not the
   contract's `like` operator, and is documented as a TS-only extension.
5. **The corpora gate the distinction.** Both fixtures now carry
   case-mismatched probes (a `Foundations` / `foundations lab` seed pair in
   the persistence corpus; lowercase `a%` / `a_an%` probes against the
   capitalized api-contract seed), so a port that lowers `like` to ILIKE,
   `UPPER()`-wrapping, or ASCII-folding LIKE fails the shared corpus instead
   of passing by construction.

## Rationale

- **The name is the contract.** An operator named after a SQL operator that
  silently behaves as a different SQL operator (ILIKE) on one backend is a
  bug in that backend, not a contract. Every written artifact (FR-009,
  ADR-0036, the api-contract doc's "SQL LIKE semantics") reads as SQL LIKE;
  none promises insensitivity.
- **The reference implementation was not univocal.** TS's designated-reference
  status cannot decide this one, because TS disagreed with itself: its
  persistence drivers and in-memory driver were case-sensitive while one
  branch of one HTTP parser was not. Four of five ports' HTTP tiers, five of
  five persistence tiers, and the recent deliberate Java ruling (0.21.4) all
  shipped case-sensitive.
- **Only the sensitive semantics can be made byte-identical everywhere.**
  Verbatim LIKE is exactly reproducible on every engine every port supports
  (plus a GLOB lowering on SQLite). The insensitive alternative fragments at
  the margins: Postgres ILIKE folds per locale, SQLite folds ASCII only,
  `UPPER()`-wrapping on OMDB's commercial-DB drivers carries locale traps and
  defeats indexes, and EF's `ILike` is Npgsql-specific. A contract that cannot
  be gated identically is not a contract.

## Consequences

- **TS Postgres HTTP behavior changes** (adopter-visible): a `like` filter no
  longer case-folds. An adopter relying on the old behavior gets it back when
  a real `ilike`-class extension ships — or normalizes case in data or
  pattern. Flagged in the changelog; the same class of output-changing
  correctness fix as Java's 0.21.4 `Expression.LIKE` change.
- **C#'s conformance adapter** now runs the same `Like` dispatch the product
  ships, so the persistence gate gates the product's semantics.
- Java, Kotlin and Python are already conformant — no product change.
- The de-blinded fixtures are the regression gate: any port re-introducing a
  case-folding `like` fails `filter-like` (api-contract) and
  `filter-like-and-ne` (persistence) on real Postgres.
