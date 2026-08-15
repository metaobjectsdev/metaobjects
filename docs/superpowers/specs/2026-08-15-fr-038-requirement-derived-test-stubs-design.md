# FR-038 — Requirement-derived test stubs: invert `@verifiedBy` so the link cannot be faked

**Status:** proposed · **Date:** 2026-08-15 · **Depends on:** the `requirement.*` family (0.22.0,
0.23.0) · **Supersedes nothing** — `@verifiedBy` stays, with a narrowed role (§7).

## 1. The problem, measured

`@verifiedBy` asks the author to name a test that proves a requirement. `meta verify` then checks
the name appears somewhere in the test corpus. **The author chooses the string, so the cheapest way
to satisfy the check is to find any name that already exists** — and an agent optimising against a
gate will take the cheapest satisfying move every time.

Auditing one real adopter ledger (55 entries, 9 carrying `@verifiedBy`, **19 names**) by opening
each named test and reading its assertions found **4 of 19 did not verify the claim**:

| what the name matched | |
|---|---|
| a **comment** — its only occurrence in the entire corpus | `mountCrudRoutes` |
| a **dependency-injection key** in test setup | `upsertLead: contactDeps.upsertLead,` |
| a **real test of a different claim** | a test that the audit row survives a persistence *failure* |
| a real test of the entry's **output**, where the claim was about its **source text** | `deriveContacts` on "the funnel names no source" |

`meta verify` reported **0 errors** throughout. The same agent authored the requirement statements
and the evidence pointers, and nothing independent existed to disagree.

The scan is not defective — it is precision-over-recall on purpose, so a "missing" verdict means
the name appears in **no** test file at all, which is broken in any ecosystem. It simply cannot
distinguish verification from coincidence. Comment-only matches now warn
(`WARN_REQUIREMENT_TEST_COMMENT_ONLY`), which reaches one of the four. **The other three are
semantic and no lexical rule will ever reach them.**

## 2. The inversion

Stop asking the author to name a test. **Generate the test from the requirement.**

```
requirement.functional  leadRecord  (L4, live)
        │  @statement / @violation
        ▼
  meta gen  ──►  tests/requirements/leadRecord.test.ts   ← generated identity, hand-written body
        │
        ▼
  meta verify --codegen  ──►  the stub exists, is current, and matches the ledger
```

The requirement's dotted path determines the test's file and name. **There is no string for the
author to choose, so there is nothing to fake.** The claim and the test are the same object viewed
from two sides.

## 3. Why this is the right shape

**It reuses the strongest gate instead of inventing a weak one.** A generated stub is an ordinary
generated artifact, so `verify --codegen` already covers "the stub exists and is current" — the
same drift gate that caught an adopter's two-release-old regen in the field. No new scan, no new
diagnostic family, no new fail-open rules to reason about.

**It inverts the authoring gradient.** Today the cheapest satisfying move is "find a name that
exists." With stubs the cheapest move is "fill in the red test already in front of you." The gate
stops rewarding the shortcut.

**It matches this repo's own doctrine.** *Pattern-derivable from metadata = codegen, never
hand-code.* A test's **identity and location** are derivable from a requirement; its **assertions**
are not. That is exactly the generated-file-with-preserved-hand-edits split ADR-0034
(scaffold-and-own) and the three-way merge already exist for: the stub is generated, the body is
hand-written inside it and survives regeneration.

**It puts the claim where the work happens.** `@statement` and `@violation` are emitted as the
file's doc comment, so whoever writes the assertion has the claim and its failure mode in front of
them. That is better prompting than a ledger in another file, and it turns the audit from a search
into a diff.

## 4. `@status` is already the emission switch

The vocabulary shipped in 0.23.0 turns out to encode exactly what each entry should emit:

| `@status` | emits | why |
|---|---|---|
| `planned` | a **skipped/todo** stub | intended, not built — a red build for something deliberately unbuilt is noise, and the existing scan already warns on skipped |
| `live` | a stub that **fails until filled** | the claim says this works; an empty green test would assert the opposite |
| `partial` | a stub that fails until filled, doc-commented with the `@disposition` and `@trackedBy` | a known gap still deserves the part that does work to be pinned |
| `abandoned` / `superseded` | **nothing**, and an existing stub is removed | the entry's job is to record that this is gone |

An empty generated stub must **not** pass. A `live` stub therefore emits a failing assertion
carrying the statement, not an empty body — otherwise the inversion recreates the original defect
in a new place.

## 5. Scope

1. A `requirementTests()` generator in `codegen-ts`, emitting one file per `requirement.*` node at
   or below the link floor (L4/L5 — organisational tiers implement nothing and get no stub).
2. Deterministic naming from the requirement's dotted path, and a collision rule (ADR-0044's
   payload-naming precedent applies: FQN-keyed with collision-scoped naming, never bare-name).
3. Emission-by-status per §4, including **removal** on `abandoned`/`superseded`.
4. `@statement` / `@violation` / `@implementedBy` rendered as the doc comment.
5. Opt-in (§6), then the four non-TS ports, each through its own codegen (the pattern exists in all
   five).

## 6. The hazard, and the opt-in it forces

**An adopter with an existing ledger would get one new red test per requirement** — 245 of them on
the poker estate, 55 on the other. That is hostile, and it would get the generator switched off
permanently on first contact, which is the outcome to avoid above all others.

So: **opt-in, per generator and per entry.** A project adds `requirementTests()` deliberately; an
entry can decline a stub. New requirements authored after adoption are the natural first users.
`@verifiedBy` remains for the case stubs cannot serve — a suite that already exists, written before
the requirement was, which is most of what an adopter has on day one.

## 7. What happens to `@verifiedBy`

It survives, narrowed and honestly documented:

- **Adoption path** — point at tests that already exist. Existence evidence, never proof, with the
  audit obligation stated in the docs (already done).
- **Greenfield path** — the generated stub, where the link is structural.

An entry with a generated stub needs no `@verifiedBy`; the two are alternatives, not layers.

## 8. What this still does not solve

**A filled-in stub can assert something irrelevant.** The inversion removes the fakeable *name*,
not the possibility of a weak assertion. What it buys is that the claim and the assertion are
co-located and diffable, and that the gradient no longer rewards the shortcut.

The unfakeable formulation remains **`@violation`-driven mutation** — "the named test goes RED when
the violation is real" — which the vocabulary already carries both halves of. It is deliberately
out of scope here: `verify` is contractually forbidden from running tests (*"it never runs them"*
is byte-gated in `expected-registry.json` across all five ports and restated in
`spec/capability-ledger.md`), so proving belongs in a separate opt-in command or an adopter-CI
recipe, specified separately. Generated stubs are the natural place for it to land later, since a
stub can carry its mutation target as structured metadata rather than the hand-written
`// MUTATION TARGET n:` comments adopters write today.

## 9. Open questions

- **Where do stubs live?** A dedicated `tests/requirements/` tree is greppable and easy to exclude
  from coverage; co-locating beside the implementation's tests is more idiomatic per ecosystem.
- **Does a stub reference `@implementedBy`?** Importing the named entity would make the stub fail
  to compile when the model moves — a stronger link than a doc comment, but it couples the test to
  generated code the requirement may not otherwise touch.
- **Renames.** A requirement renamed at L4 changes its stub's identity; the three-way merge cannot
  follow that, so the hand-written body would be orphaned. Needs a rename story before this is
  usable on a ledger that churns.
- **Does the failing-stub default break `meta init`'s first run?** A scaffold that ships red is a
  bad first impression; likely the scaffolded ledger starts with `planned` entries only.
