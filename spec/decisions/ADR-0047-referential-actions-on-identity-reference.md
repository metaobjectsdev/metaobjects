# ADR-0047: `@onDelete` / `@onUpdate` are registered on `identity.reference` (db-provider), and the parent-side relationship correlates to the child's FK

## Status

**Accepted** (2026-08-10). Governed by [ADR-0023](ADR-0023-strict-metadata-provenance.md)
(strict provenance — this document is the required written can't-be-computed
justification) and classified under [ADR-0037](ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
(vocabulary expansion: an *attribute*, not a subtype or `@kind`). Reverses the
SP-G Unit 6a removal of these attrs from the JVM `ReferenceIdentity` — that removal
matched the canonical, but the canonical itself had drifted from the shipped
migrate engine's behavior.

## Context

Two coherent halves of one defect, reported by an adopter audit:

**1. The migrate engine honored an attribute the metamodel never registered.**
`meta migrate` / `meta gen` load metadata **lax** (open-attr policy), while
`meta verify` loads **strict** (ADR-0023, #96). The TS migrate engine's
`resolveReferentialActions` reads `@onDelete` / `@onUpdate` declared directly on
`identity.reference` as its highest-precedence tier — with tests pinning it, and
`docs/features/relationships.md`'s canonical example authoring it — yet
`identity.reference` in `expected-registry.json` declared only `constraintName` /
`enforce` / `fields` / `references`. Result: a model could `meta migrate --apply`
cleanly and then fail `meta verify` outright with `ERR_UNKNOWN_ATTR` on the same
metadata. **Migrate and verify must never disagree on what a valid model is.**
(The same doc simultaneously stated the attr "fails load with `ERR_UNKNOWN_ATTR`" —
the documentation contradicted itself because the implementation contradicted the
registry.)

**2. The documented parent-side relationship never reached the FK.** The docs and
the `metaobjects-authoring` skill teach declaring ownership on the **parent**
(`relationship.composition { @objectRef: "Post", @cardinality: "many" }` on
`Author`), with the subtype implying the default action (composition→`cascade`,
aggregation→`set-null`, association→`restrict`). But the correlation in
`resolveReferentialActions` scanned only relationships declared on the FK-owning
**child** — so the documented shape contributed nothing, the FK emitted with no
`ON DELETE`, and deleting a parent with children hit the database's bare-FK
restrict as a raw 500. No conformance fixture authored the parent-side `many`
shape or relied on a subtype *default* (the one referential-actions fixture is
child-side, `@cardinality: "one"`, all actions explicit), which is why nothing
caught either half.

## Decision

### 1. `@onDelete` / `@onUpdate` are REGISTERED on `identity.reference`

Both attrs: optional, `string`, `allowedValues: ["cascade", "set-null",
"restrict", "no-action"]` — the same closed set as on `relationship.*`.
Contributed by the **db provider** (`spec/metamodel/db.json`'s
`identity.reference` extends block), exactly like `@constraintName`: the
referential action is syntactically and semantically part of the SQL FK
constraint (`REFERENCES … ON DELETE …`), i.e. RDB-physical configuration of the
reference, not core identity semantics. Registered in all five ports and in
`expected-registry.json`.

**Precedence (the resolver contract, unchanged in shape, now fully specified):**

1. `@onDelete` / `@onUpdate` declared directly on the `identity.reference` — the
   explicit per-FK override; always wins.
2. A correlated relationship on the FK-owning entity — matched **package-aware**
   against the resolved `@references` target (`refMatchesObject` / ADR-0042, so
   bare and FQN forms pair correctly); an M:N (`@through`) relationship never
   correlates with a direct FK. Its explicit action, else its subtype default.
3. A correlated **reverse** relationship on the target entity (the parent-side
   authoring shape — see Decision 2): its explicit action, else its subtype
   default.
4. None → no `ON DELETE` / `ON UPDATE` clause.

The recommended authoring stays relationship-level — the subtype carries the
semantics and the default. The reference-level attr is an override/escape hatch,
never a restatement.

### 2. The parent-side relationship correlates to the child's FK

`resolveReferentialActions` gains tier 3: when no relationship on the FK-owning
entity correlates, the resolver looks up the reference's target entity
(package-aware, via the loader's `resolveObjectRef` / ADR-0042 contract) and
correlates a relationship declared **there** whose `@objectRef` points back at
the FK-owning entity. Guards, each failing closed to "no contribution":

- An M:N relationship (`@through`) never correlates — it describes the junction
  path, not this direct FK (the junction's own FKs correlate through the
  junction's own `identity.reference` children). The same guard applies at
  tier 2.
- When the FK-owning entity holds anything other than **exactly one** enforced
  reference to the target — and that reference must be the one being resolved —
  the reverse relationship contributes to **none** of them: it cannot say which
  FK carries the ownership edge, and arming all of them could cascade through an
  edge the author never designated (a soft `@enforce: false` reference never
  correlates).
- An **inferred** set-null default (parent-side aggregation with no explicit
  `@onDelete`) on a NOT NULL FK is unsatisfiable: the inferred contributions
  drop (the FK stays bare) so the smarter correlation never turns a
  previously-valid model into a hard `SetNullNotNullableError` — while anything
  explicitly authored survives (an explicit `set-null` flows through to the
  loud nullability error; an explicit `@onUpdate` on that same relationship is
  still honored).
- A child-side relationship, when present, fully resolves at tier 2 (explicit or
  default) — tier 3 is never consulted.

**Output-compatibility contour:** models whose FKs previously received an action
(reference-level attr or a correlating child-side relationship) are
byte-identical. Two shapes intentionally change, both restoring declared
intent that was previously silently dropped: (1) the parent-side relationship
now contributes (the fix); (2) a child-side relationship authored with an FQN
`@objectRef` (load-valid since ADR-0041) previously failed the exact-string
tier-2 match and contributed nothing — the package-aware match now honors it
(and prevents the parent-side tier from overriding a child-side declaration
whose spelling merely differed).

### 3. The `"setnull"` alias is retired

`allowedValues` membership is enforced **unconditionally** at load (not
strict-gated), so registering the attrs makes `@onDelete: "setnull"` on a
reference fail load with `ERR_BAD_ATTR_VALUE` — exactly as it always has on
`relationship.*`. The migrate engine's normalize-time alias (`"setnull"` →
`"set-null"`) was reachable *only* through the unregistered-attr hole and is
removed. Canonical spelling is kebab-case, one form, all ports.

## ADR-0023 justification — why the value cannot be computed

ADR-0023 requires proving a new attribute's value cannot be derived from
existing metadata. Where a relationship exists, the *default* action **is**
derived (from the subtype — Decision 2 extends that derivation to the
parent-side shape rather than adding vocabulary for it). The registered
reference-level attr covers the cases where no existing metadata implies any
action:

1. **A reference-only FK.** A model may declare an FK with no `relationship.*`
   correlate at all — the docs explicitly support reference-only navigation
   (`@via` a reference), and adopted/reverse-engineered schemas routinely carry
   FK constraints with actions but no ownership semantics worth modeling. For
   such an FK the desired action (e.g. the `ON DELETE CASCADE` already present
   on the adopted database) is **inexpressible** without this attr: `meta
   verify --db` reports permanent drift, and `meta migrate` would try to strip
   the action. The only workarounds are to invent a relationship the author
   does not want — which changes generated *navigation* surface (finders, REST
   traversal, relations blocks) as a side effect of a DB-physical need — or
   `attr.properties`, which codegen deliberately never reads.
2. **M:N junction FKs.** FR-018 derives a junction's FKs from its two
   `identity.reference` children; the M:N relationship's `@objectRef` names the
   *far side*, never the junction, so **no relationship correlates with a
   junction FK by construction**. Junction rows almost always want
   `ON DELETE CASCADE` on both sides; the reference-level attr is the only
   non-artificial way to say so.
3. **A per-FK override that differs from every declared relationship.** Two FKs
   to the same target with different actions; or DB behavior deliberately
   decoupled from the modeled ownership (soft-delete pipelines). The override
   is information the relationship layer does not carry — same standing as an
   explicit `@onDelete` on a relationship overriding its subtype default.

The asymmetry that makes this the natural home: the `identity.reference` **is**
the FK (FR-018's SSOT for FK direction), and in SQL the action is a clause *of
the FK constraint*. An attribute configuring an existing subtype, with no native
type and no structural variant, is ADR-0037's "attribute" arm — on the node that
owns the construct it configures.

**The rejected alternative** — stop honoring the attrs and strip them from the
engine — was coherent (it is what SP-G Unit 6a assumed) but loses cases 1–2
outright, breaks migrate-clean adopter models that used the documented example,
and re-opens the drift it removes only if the engine forgets to strip every read
(the state this ADR ends).

## Consequences

- All five ports register the attrs (TS embedded db provider; C# + Python
  committed `SpecMetamodel`/`spec_metamodel` `db.json` copies; JVM
  `ReferenceIdentity` + spec enrichment; Kotlin inherits the JVM loader).
  `expected-registry.json` regenerated; the registry-conformance gate holds the
  five ports to it.
- A new shared conformance fixture (`identity-reference-referential-actions`)
  authors BOTH previously-untested shapes — the parent-side `many` composition
  relying on its subtype default, and reference-level `@onDelete`/`@onUpdate` —
  so every port's strict conformance load gates the vocabulary, and the migrate
  emit tests gate the DDL.
- The durable invariant this enforces: **any model `meta migrate` accepts must
  load under strict `meta verify`.** The migrate engine's own referential-action
  test corpus now loads strict, so a future migrate-honored-but-unregistered
  attr fails the migrate suite itself, not an adopter's verify run.
- `docs/features/relationships.md` and the `metaobjects-authoring` skill teach
  the precedence and the (now-working) parent-side default; the doc's
  self-contradiction is resolved in favor of "registered, with relationship-level
  authoring recommended".
- Behavior changes: (1) the parent-side shape now emits the documented action —
  an intentional bug fix (adopters whose live DB has the bare FK will see a
  one-time legitimate migration adding the action); (2) `"setnull"` fails load
  everywhere with `ERR_BAD_ATTR_VALUE` (previously honored only via the
  unregistered hole).
