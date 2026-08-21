# The coordinated pre-1.0 breaking batch — implementation plan

**Date:** 2026-08-21 · **Status:** in progress · **Target release:** `0.24.0` (npm/PyPI/NuGet)
· `7.24.0` (Maven), which is drafted-but-unreleased and already carries ADR-0052/0053.

**Ruling (2026-08-21):** the batch lands BEFORE the 1.0 renumbering, and all of it rides
`0.24.0` rather than a second MINOR behind it. The 0.24.0 cut is HELD until this plan is
complete. Charter: `spec/roadmap.md` → "The next coordinated pre-1.0 breaking MINOR".

## Why one window

Every item here retires registered vocabulary. Under ADR-0023's sealed strict registry a
retirement has no deprecation shim — a legacy model fails to load — so each one is a
migration an adopter must perform. Two breaking MINORs back to back means two migrations
for changes that were budgeted as one. Hence: one window, one migration guide, one
`metamodelVersion` move.

## What is already done

- **ADR-0052 / ADR-0053** — `@promptStyle` moved to `template.prompt`, `@responseFormat`
  added. Shipped on `main` (PR #318), documented in `[0.24.0]`.
- **`metamodelVersion` 0.9 → 0.10** and its gate (PR #322). This batch moves it again,
  `0.10 → 0.11`, ONCE at the end — pre-1.0 a breaking metamodel change moves the MINOR.

## Units

Three independent units. Order is smallest-first: each lands complete (all ports, fixtures,
docs) and is committed on its own before the next starts.

| | Unit | Retires | Source files touched (approx) |
|---|---|---|---|
| U1 | FR-038 vocabulary | `@verifiedBy` **only** — see the ruling below | ~26 |
| U2 | FR-037 R2 | `origin.collection` | ~45 |
| U3 | FR-037 R1 | `@readOnly` → `@mutability` enum | large |

Ports that register vocabulary: **TypeScript, C#, Java, Python** (Kotlin inherits the JVM
registry). Plus `spec/metamodel/*.json`, each port's embedded definitions, the C# and Python
COMMITTED `SpecMetamodel` copies, and the byte-gated
`fixtures/registry-conformance/expected-registry.json`.

---

## U1 — FR-038: the requirement vocabulary becomes prescriptive-only

Design: `docs/superpowers/specs/2026-08-15-fr-038-requirement-derived-test-stubs-design.md` §4.

**Scope is the RETIREMENT ONLY.** The `requirementTests()` generator is additive and stays
on its own plan (`2026-08-16-fr-038-requirement-test-codegen.md`) targeting 1.1. Retiring
`@verifiedBy` before that generator exists is deliberate per §5 — policy is the downstream
application's, and a requirement with no test link is a legitimate declared state.

1. **Rehome the contract sentence FIRST, before deleting anything.** *"verify checks each
   name EXISTS and is not skipped; it never runs them, and it cannot tell whether the named
   test verifies this requirement — any occurrence in the test corpus satisfies it"* is
   today byte-gated inside `@verifiedBy`'s own description in `expected-registry.json`
   (twice — once per subtype). Deleting the attribute deletes the only gated statement of a
   load-bearing guarantee. Confirm `spec/capability-ledger.md` states it; carry the finding
   into the migration guide as the RATIONALE for the retirement. This is the ADR-0047
   renumbering trap class: a string that reads like prose is a gated artifact.
2. **RULED — all four retire** (`9f4585f9b`, 2026-08-20). `@status` shrinks to
   `planned | live | partial`; `@verifiedBy` and `@supersededBy` are deregistered on both
   subtypes, all four ports. Retiring a capability is now DELETION of its requirement.
   - **The ruling was forced by two SHIPPED statements contradicting each other.** The
     byte-gated registry justified the dangling-`@implementedBy` exemption because those
     nodes "are meant to be gone, and that is the entry doing its job"; the authoring
     guidance said deleting the entry "destroys the record"; §4 says a requirement "is not a
     record of what happened". Only one could be the rule.
   - **The deciding argument is second-order.** An adopting estate held **29
     `@implementedBy` refs that could never resolve**, across 14 entries, every one invisible
     because `verify` is silent on exactly those two statuses — zero dangling refs reported,
     true and incomplete at once. Retiring them DELETES that bug class; the exemption is the
     only thing that created it.
   - **Migration cost measured, not estimated** — three estates (262/75/288 entries): 0, 15
     and 88 edits, ~85% landing on one ledger, one estate untouched.
   - **Where the record goes:** version control, plus `notes` on surviving entries. Estate C
     had already moved retirement history out of `@implementedBy` into `notes` unprompted.
   - **How this was nearly got wrong, recorded because the mechanism failed.** A challenge on
     2026-08-21 concluded "retire `@verifiedBy` only", and BOTH arms named an adopter scan as
     the one thing that would flip them. The scan existed — in this very commit — but was
     unpushed, so the brief asserted it had not been run. A false premise poisons both arms
     identically, which is exactly what the challenge skill names as its dominant failure
     mode. **Check unmerged work before contradicting a ruling.**
3. `@verifiedBy` and `@supersededBy` deregistered on both subtypes, all four ports; the five
   `@status` members become three.
4. Constants: drop `REQUIREMENT_ATTR_VERIFIED_BY`, `REQUIREMENT_ATTR_SUPERSEDED_BY`,
   `REQUIREMENT_STATUS_ABANDONED`, `REQUIREMENT_STATUS_SUPERSEDED` and their accessors in all
   four ports. **Sweep by member VALUE, not constant name** — the strings appear in spec
   files, embedded definitions, four authoring skills and the adopter docs.
5. `REQUIREMENT_STATUSES_REQUIRING_LIVE_NODES` keeps `live`/`partial`; `planned` becomes the
   sole exemption, and every comment describing the old pair-asymmetry is rewritten.
6. **Retire the `@verifiedBy` scan tier** in the TS CLI: `verified-by-scan.ts`, its wiring
   in `verify.ts`, `verify.testFiles` in `metaobjects-config.ts`, and the codes
   `ERR_REQUIREMENT_TEST_MISSING` / `WARN_REQUIREMENT_TEST_COMMENT_ONLY`. Note the irony
   for the changelog: 0.23.1 shipped the Failsafe fix and `verify.testFiles` for this exact
   scan days before it is retired — say so plainly rather than letting an adopter discover
   it.
7. Fixtures: `requirement-disposition-and-planned` and `requirement-levels-and-nesting`
   both declare `@verifiedBy` — re-express. Add `error-requirement-verified-by-retired`
   proving a legacy `@verifiedBy` → `ERR_UNKNOWN_ATTR`.
8. Migration guide under `docs/features/migrations/`.

**Acceptance:** registry-conformance green in all five ports with `@verifiedBy` absent; the
new error fixture green in all five; no source reference to it outside the migration guide
and the passages explaining the retirement; `meta verify` still prints its requirements
summary (0.23.0) with the test-link line gone.

**STATUS: COMPLETE.** All four registering ports green — TS 2408 · sdk 278 · C# 291+944+53+363
(four `Passed!` lines, 0 `error CS`) · Python 1826 · Java `ConformanceTest` 570 /
`RegistryManifestConformanceTest` 3 / `RequirementTest` 7, reports verified fresh.
`metamodelVersion` needed **no** further move: the gate's baseline is the last release tag, so
`0.10` — already moved for ADR-0052 this cycle — covers this break too, and
`check-metamodel-version.mjs` exits 0. Its prose warning was answered deliberately: the single
prose edit is `requirement.functional @trackedBy`, dropping a cross-reference to the retired
attr — wording, not rule.

---

## U2 — FR-037 R2: retire `origin.collection` to reserved-not-registered

Design: `docs/superpowers/specs/2026-08-10-fr-037-projection-expressiveness-and-write-once-design.md` R2.

The case: it duplicates `origin.aggregate @agg: collect` on a smaller attr set (`@via`
only — no `@filter`, no `@orderBy`), and it has **no implementation**. Its last real
consumer, the payload-VO typing edge, was deleted in 0.20.16 (#270) for being actively
wrong. Nothing dispatches on it, which is exactly the ADR-0007 Amendment 2 re-entry bar
read in reverse.

1. Deregister from every port's origin provider and from `expected-registry.json`; a legacy
   use fails `ERR_UNKNOWN_SUBTYPE` (D4 — a de-registered subtype is unknown by definition).
2. Shrink `ASSEMBLY_ORIGIN_SUBTYPES` in every loader, in lockstep — #210's property that
   cross-port coverage is a property of the shared constant, not of four branches.
3. Delete `MetaCollectionOrigin` and any residual registration/serializer arms.
4. **Value sweep**, not constant-name sweep: spec files, embedded definitions, the
   authoring skills, `docs/`, and CLAUDE.md's cross-language contract list all name
   `collection` in the origin subtype set.
5. Document reserved-not-registered status + the Amendment-2 re-entry bar + the designated
   fold-in re-entry shape (`@agg: collect` with `@of` OPTIONAL) where ADR-0040 documents
   its reserved index subtypes.
6. Migration: delete the child, or re-model as `@agg: collect`.

**Acceptance:** registry-conformance green with the subtype absent; legacy-use error
fixture green in all five ports; #210's value-host rejection still green for the remaining
assembly origins; no-churn for models that never declared it.

---

## U3 — FR-037 R1: `@readOnly` → `@mutability`

Design: same doc, R1. The largest unit; do it last and do it whole.

`@mutability: readWrite | writeOnce | readOnly` on `field.base`, default `readWrite`,
registered by the CORE field provider (not the db provider) — the home `@readOnly` occupies
today, **18 registry entries** in `expected-registry.json`.

The shape argument, which is the reason this cannot be two booleans: `readOnly` and
`writeOnce` are mutually exclusive modes of ONE axis (who may write, and when). One enum
makes the illegal pair unrepresentable and gives inheritance a total order
(`readWrite < writeOnce < readOnly`).

**The write-semantics contract** (`@mutability` × `@autoSet` — two axes, documented
together so they cannot drift; this table is itself a deliverable and lands in the attr
descriptions and the API docs):

| declaration | supplied by | POST | PATCH |
|---|---|---|---|
| `readWrite` (default, absent) | caller | yes | yes |
| `writeOnce` | caller | yes | **no — excluded from the settable set** |
| `@autoSet: onCreate` (needs `readWrite`) | server | no | no |
| `@autoSet: onUpdate` (needs `readWrite`) | server | no | no |
| `readOnly` | nobody | no | no |

1. Register `@mutability`; retire `@readOnly` everywhere (5 ports + manifest).
2. Loader validation, all five ports, with conformance error fixtures:
   - `ERR_MUTABILITY_AUTOSET_CONFLICT` **(new)** — `@autoSet` with `writeOnce` OR
     `readOnly`. The boolean era left readOnly×`@autoSet` representable but unvalidated;
     the enum cut closes both with one rule.
   - `ERR_MUTABILITY_DOWNGRADE` **(new)**, replacing `ERR_READONLY_DOWNGRADE` — a subtype
     may tighten an inherited mode, never loosen it. Renamed because the rule now spans
     modes and a code named READONLY misdescribes a `writeOnce → readWrite` loosening.
   - `ERR_READONLY_ASSIGNED_PRIMARY` **keeps its name** — the condition is readOnly-specific.
     Note the asymmetry: `writeOnce` on an assigned primary is LEGAL and indeed natural.
   - `WARN_MUTABILITY_VALUE_OBJECT` **(new)**, replacing `WARN_READONLY_VALUE_OBJECT`.
   - `writeOnce` on a read-only host (projection / read-only `@kind`) → WARN, benign.
3. **Output equivalence:** `@mutability: readOnly` emits byte-identically to today's
   `@readOnly: true`, pinned by a test. Metadata with no `@mutability` is byte-identical to
   today.
4. `writeOnce` excluded from the PATCH settable set — the mechanism that excludes
   `@autoSet: onCreate` from the UpdateSchema walk today. Includes the FR-035 present-null
   arm: clearing is a write.
5. **D1 — a presented `writeOnce` key on PATCH is STRIPPED, not 400'd.** Grounding: it is
   the uniform behaviour of every excluded-settable-set key on this path today. The
   decisive mechanical fact is that the generated edit form submits EVERY registered field
   (`handleSubmit` passes all values; 0.19.2 switched the resolver to UpdateSchema on edit
   and does not diff-and-omit) — so 400-on-present would fail every save on every generated
   edit form for an entity carrying a `writeOnce` field. It breaks our own shipped client.
6. **ADR-0045 verbatim:** the OUTERMOST generated write artifact enforces the mode, vanilla
   AND TPH per-subtype, all five ports. The 0.19.4 lesson is that TPH is a separate code
   path per port unless gated.

**Acceptance:** registry-conformance green with `@mutability` present and `@readOnly`
absent; output-equivalence and no-churn pins; the error fixtures green in all five ports;
the value-object WARN unit-tested per port (the corpus has no warn-fixture mechanism —
ADR-0043 §4 precedent); a legacy-`@readOnly` fixture proving `ERR_UNKNOWN_ATTR`;
`api-contract-conformance` in BOTH lanes, every port, vanilla AND TPH: POST sets a
`writeOnce` field, a later PATCH carrying a new value returns **200 with the stored value
unchanged**, and present-null does not clear it.

---

## Close-out (after U3)

- `node scripts/check-metamodel-version.mjs --set 0.11` — once, at the end. Never hand-edit;
  a partial edit only fails in the forgotten port's lane.
- Answer the gate's PROSE warning deliberately (it cannot classify a `rules`/`description`
  change, and this batch rewrites several) — that answer is a human step, by construction.
- Fold all three units into the `[0.24.0]` CHANGELOG section, extending the existing
  ⚠️ BREAKING callout rather than adding a second one.
- One migration guide covering all three retirements, per Shared obligation 5.
- Update `spec/roadmap.md`: FR-037 R1/R2 and FR-038's breaking halves ship; R3/R4/R5 and the
  stub generator remain 1.1. Resolve the "open tension" paragraph — the ruling is recorded.
- **Reset the §G3 quiet-period clock** in `docs/1.0-readiness.md`: 1.0 now needs at least one
  coordinated release after this one with no metamodel-breaking change, to prove the rate
  actually dropped. This cost was adjudicated, not discovered — say so.
- Tell `metaobjects-fb` the hold is lifted.

## Standing constraints

- TDD: the failing test first, every time.
- No `any`; named constants for every metamodel string; resolving accessors by default
  (ADR-0039) — an `own*()` call needs a comment naming its sanctioned case.
- Never `instanceof` a metadata node across packages — use the exported guards.
- Public repo: no absolute home paths, no private project names, in code, fixtures, docs OR
  commit messages.
- `cd server/typescript && bun test` scoped per package; never a bare `bun test` at the root.
- A corpus that stops exercising a path emits no diagnostic. Every fixture removed or
  re-expressed here must have its purpose re-stated in the corpus README.
