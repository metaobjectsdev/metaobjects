# FR-038 — Requirement-derived tests: generate the proof, retire the claim

**Status:** §4 vocabulary RULED (2026-08-20) · rest proposed · **Date:** 2026-08-15 ·
**Revised:** 2026-08-16 (owner review — see §0) · **Depends on:** the `requirement.*`
family (0.22.0, 0.23.0) · **Supersedes:** `@verifiedBy` (§4), which this retires rather
than narrows.

## 0a. The §4 `@status` ruling is REVERSED IN PART (2026-08-26) — read FR-039 first

**The `@status` half of §4 does not stand.** [FR-039](2026-08-26-fr-039-retired-status-restore-design.md)
restores a retired-capability status as a single `@status: retired` member, and
[the requirements-as-metadata ruling](../../../spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md)
Amendment 4 records why.

In short: the ruling that authorised `requirement.*` tested six claims and refuted five. The
one that held — 0 of 24 without a ledger, 19 of 40 with — is the retired-capability
guardrail, and §4 removed it while leaving the five refuted claims in place. §4's own
evidence (29 unresolvable `@implementedBy` references reported as zero) is real but is a
**reporting** defect: those references dangle because the ruling deliberately specified that
they should. FR-039 answers it structurally instead, by **forbidding** `@implementedBy` on a
retired entry so the references cannot exist.

**What survives from §4, unaffected:** the retirement of `@verifiedBy` — whose reasoning is
independent and stands in full — and the prescriptive/journal rule itself, which FR-039
keeps and satisfies rather than overturns.

## 0b. The §4 ruling (2026-08-20)

**Ruled: retire all three together** — `abandoned`/`superseded` from `@status`,
`@supersededBy`, and `@verifiedBy` — as §4 specifies, in one breaking change rather than
split into separate decisions. The rest of FR-038 (the generator, §5 app-owned policy, the
§4 emission table) remains proposed and is NOT ruled by this.

**What forced the ruling now.** Two shipped statements contradicted each other about the
same vocabulary. The byte-gated registry description justifies the dangling-`@implementedBy`
exemption on `abandoned`/`superseded` because those nodes "are meant to be gone, and that is
the entry doing its job", and CLAUDE.md adds that deleting the entry "destroys the record" —
the record matters. §4 says a requirement "is not a record of what happened" — the record
does not belong here. Both could not stand.

**The deciding argument was second-order.** An adopting estate was found carrying **29
`@implementedBy` refs that could never resolve**, across 14 entries, every one invisible
because the check is silent on exactly these two statuses — `meta verify` reported zero
dangling refs, which was true and incomplete at the same time. The obvious fix was to emit
INFO for that case. Retiring the statuses is better than fixing it: it **deletes the bug
class** rather than making it visible, because the exemption is the only thing that created
it. A patch would have been built on vocabulary this ruling removes.

**Migration cost, measured across three adopting estates rather than estimated** — 262, 75
and 288 entries respectively:

| | `abandoned` | `superseded` | `@verifiedBy` | `@supersededBy` | edits |
|---|---:|---:|---:|---:|---:|
| estate A | 0 | 0 | 0 | 0 | **0** |
| estate B | 3 | 0 | 12 | 0 | 15 |
| estate C | 48 | 12 | 4 | 24 | 88 |

~85% of the migration lands on one ledger; one estate is untouched. Estate C had already
moved retirement history out of `@implementedBy` and into `notes` prose on its own
initiative, reasoning that "what used to implement a retired capability is real information
in the wrong field" — which is this ruling's direction reached independently, one step
short of deleting the entry.

**Consequence for the migration guide:** it must say where the record goes, because
"deletion" is the part adopters will resist. Git history plus `notes` on the surviving
entries is the answer, and estate C's precedent is the worked example.

## 0. What the 2026-08-16 review changed

The 2026-08-15 draft proposed one built-in generator emitting one stub per requirement,
kept `@verifiedBy` in a narrowed role, and treated the L4/L5 link floor and
"architectural takes no tests" as rules. The owner's review changed four things:

1. **Requirements are prescriptive only.** They state what *should* happen, never journal
   what happened. `@status` loses `abandoned`/`superseded`; retirement is deletion (§4).
2. **`@verifiedBy` is retired outright**, not narrowed (§4). The draft kept it for the
   adoption path; that case does not survive app-owned policy.
3. **Policy belongs to the downstream application** — which requirements get tests, at
   which levels, in what style, or none at all. The library ships mechanism and
   *recommendations*, never rules (§5).
4. **One requirement fans out per referenced metadata type**, not one stub per
   requirement (§7) — so a claim spanning an entity, a view and a validator gets one
   test per concern.

And it added the dogfood scope (§9): MetaObjects becomes the first adopter, with the
conformance corpus tied back to requirements.

## 1. The problem, measured

`@verifiedBy` asks the author to name a test that proves a requirement. `meta verify` then
checks the name appears somewhere in the test corpus. **The author chooses the string, so
the cheapest way to satisfy the check is to find any name that already exists** — and an
agent optimising against a gate will take the cheapest satisfying move every time.

Auditing one real adopter ledger (55 entries, 9 carrying `@verifiedBy`, **19 names**) by
opening each named test and reading its assertions found **4 of 19 did not verify the
claim**:

| what the name matched | |
|---|---|
| a **comment** — its only occurrence in the entire corpus | `mountCrudRoutes` |
| a **dependency-injection key** in test setup | `upsertLead: contactDeps.upsertLead,` |
| a **real test of a different claim** | a test that the audit row survives a persistence *failure* |
| a real test of the entry's **output**, where the claim was about its **source text** | `deriveContacts` on "the funnel names no source" |

`meta verify` reported **0 errors** throughout. The same agent authored the requirement
statements and the evidence pointers, and nothing independent existed to disagree.

The scan is not defective — it is precision-over-recall on purpose, so a "missing" verdict
means the name appears in **no** test file at all, which is broken in any ecosystem. It
simply cannot distinguish verification from coincidence. Comment-only matches now warn
(`WARN_REQUIREMENT_TEST_COMMENT_ONLY`), which reaches one of the four. **The other three
are semantic and no lexical rule will ever reach them.**

**Correction to a premise raised in review:** `@verifiedBy` was never *required*. It is
`required=False` on both subtypes and the scan is opt-in by declaration
(`verified-by-scan.ts` returns early when no entry declares one); absence is never
flagged. The case for retiring it is not that it forced fake data — it is that it was
**used by 9 of 55 entries and wrong in 4 of 19 names**, while reporting clean.

## 2. The inversion

Stop asking the author to name a test. **Generate the test from the requirement.**

```
requirement.functional  leadRecord  (L4, live)
        │  @statement / @violation
        ▼
  meta gen  ──►  tests/requirements/leadRecord.<concern>.test.ts
        │        generated identity, hand-written body
        ▼
  meta verify --codegen  ──►  the stub exists, is current, and matches the model
```

The requirement's dotted path and the concern determine the file and name. **There is no
string for the author to choose, so there is nothing to fake.** The claim and the test are
the same object viewed from two sides.

## 3. Why this is the right shape

**It reuses the strongest gate instead of inventing a weak one.** A generated stub is an
ordinary generated artifact, so `verify --codegen` already covers "the stub exists and is
current" — the same drift gate that caught an adopter's two-release-old regen in the
field. No new scan, no new diagnostic family, no new fail-open rules.

**It inverts the authoring gradient.** Today the cheapest satisfying move is "find a name
that exists." With stubs the cheapest move is "fill in the red test already in front of
you." Retiring `@verifiedBy` (§4) is what makes that stick: leaving it available leaves
the cheap path open, which would undercut the gradient argument this rests on.

**It matches this repo's own doctrine.** *Pattern-derivable from metadata = codegen, never
hand-code.* A test's **identity and location** are derivable from a requirement; its
**assertions** are not. That is exactly the generated-file-with-preserved-hand-edits split
ADR-0034 (scaffold-and-own) and the three-way merge already exist for.

**It puts the claim where the work happens.** `@statement` and `@violation` are emitted as
the file's doc comment, so whoever writes the assertion has the claim and its failure mode
in front of them. That turns the audit from a search into a diff.

## 4. Vocabulary: prescriptive only — BREAKING

A requirement states what **should** happen. It is not a record of what happened.

**`@status` shrinks to a closed set of three:** `planned | live | partial`.
`abandoned` and `superseded` are retired; a requirement that no longer applies is
**deleted**, not annotated.

**`@supersededBy` retires with them.** It exists to point from a superseded entry to its
replacement; with no `superseded` status and the entry deleted on retirement, nothing can
legally carry it. Leaving a registered attribute no valid model can use is the hygiene
failure FR-037 R2 addresses for `origin.collection`, and the same ADR-0007 Amendment 2 bar
applies: nothing dispatches on it.

**`@verifiedBy` retires.** §1 is the evidence. The draft preserved it for adopters with
pre-existing suites, but under app-owned policy (§5) that case dissolves: a requirement
outside every generator filter simply has no test link, and that is a legitimate declared
state. `@verifiedBy` only ever offered *existence* evidence, never proof — retaining it
preserves a false comfort and the cheap path.

**`@disposition` and `@trackedBy` survive** — they hang off `partial`, which remains: a
known gap still deserves the part that does work to be pinned.

**Cost, stated plainly.** `abandoned`/`superseded` are registered `allowedValues` and
`@verifiedBy`/`@supersededBy` are registered attributes in 0.23.x, so existing metadata
using any of them fails to load (`ERR_BAD_ATTR_VALUE` / `ERR_UNKNOWN_ATTR`). This is a
**breaking metamodel change across five ports** plus the byte-gated
`expected-registry.json`, and it should ride the same coordinated pre-1.0 breaking slot as
FR-037's `@mutability`, not a second one. A migration note belongs under
`docs/features/migrations/`.

**A contract statement has to be rehomed.** The `verify`-never-runs-tests contract — *"it
never runs them, and it cannot tell whether the named test verifies this requirement — any
occurrence in the test corpus satisfies it"* — is currently byte-gated **inside
`@verifiedBy`'s own attribute description** (verified: it appears once per subtype in
`expected-registry.json`). Retiring the attribute deletes the only gated statement of that
contract. It must move to a surviving home — `spec/capability-ledger.md` already restates
it — before the attribute is removed, or a load-bearing guarantee silently loses its gate.
This is the same class as the ADR-0047 renumbering trap: a string that reads like prose is
actually a gated artifact.

**The emission table simplifies to three rows**, and is a *default* the renderer may
override (§5), not a fixed rule:

| `@status` | default emission | why |
|---|---|---|
| `planned` | a **skipped/todo** stub | intended, not built — a red build for something deliberately unbuilt is noise |
| `live` | a stub that **fails until filled** | the claim says this works; an empty green test would assert the opposite |
| `partial` | fails until filled, doc-commented with `@disposition` and `@trackedBy` | a known gap still deserves its working part pinned |

The draft's fourth row — remove the stub on `abandoned`/`superseded` — disappears. Removal
is now driven by deletion of the requirement (§8), which is ordinary drift.

**An empty generated stub must not pass.** A `live` stub emits a failing assertion carrying
the statement, never an empty body — otherwise the inversion recreates the original defect
in a new place.

## 5. Policy belongs to the downstream application

The library owns the **mechanism**. The application owns the **policy**. We ship
**recommendations**.

An application may cover only L4/L5, or include L3, or test architectural requirements, or
generate nothing for a whole subtree. None of that is the library's decision. The 2026-08-15
draft's link floor and the ruling's "architectural takes no tests" both demote from rules to
defaults.

**The filter is the policy declaration.** A requirement matched by no generator expects no
stub *by construction* — there is nothing to emit and nothing for `verify --codegen` to
drift against. This is why **no opt-out vocabulary is needed**: an `@noTest` attribute would
have to clear ADR-0023's can't-be-computed bar, and it cannot, because the generator config
already says it.

**Silence is the hazard.** A requirement can fall through every filter and be
indistinguishable from a deliberate exclusion. So `meta gen` emits **one self-extinguishing
warning** naming requirements no generator covers — informative, never failing, and
suppressible. This is the shape of the 0.21.4 grid-discoverability warning, which exists
because "intended, but documented nowhere" is how a feature becomes invisible.

**Where the recommendations live:**

- the **scaffolded config** ships a default filter (functional, at the link floor) with a
  comment stating it is the app's to change — the ADR-0034 pattern teaches by being editable
- the **authoring skill** carries the violability rule and the functional/architectural
  discriminator
- the **docs** state the reasoning: an architectural requirement is usually proven by
  `verify`'s universality check rather than by a test, so a test there is often redundant —
  *usually*, not *never*

## 6. The generator contract

```ts
requirementTests({
  name: "req-tests-api",
  filter: r => r.subType === "functional" && r.level >= 4,
  renderers: {
    "object.entity": renderApiTest,
    "view.*":        renderUiTest,
    "validator.*":   renderValidationTest,
  },
  target: "api-tests",
})
```

An application registers as many instances as it has groupings — one per requirement kind,
level band, package, or testing style.

**A finding this design runs into: the `Generator` contract is entity-shaped.**
`GenContext.entities` is `MetaObject[]` and `filter` is `(entity: MetaObject) => boolean`,
so a requirement-driven generator cannot use `filter` at all and must walk `loadedRoot`
itself. This FR works within that (the factory does the walk); generalising `Generator`
over any node kind is the principled fix and is **explicitly out of scope** — it is a core
contract change touching every existing generator in five ports, and should not be forced
by this FR.

**No forced upstream fixes.** Every policy decision is a default with a seam. If an
application can hit it and cannot change it, it becomes a bug report:

| decision | default | the app's seam |
|---|---|---|
| which requirements get stubs | functional at link floor | `filter` |
| fan-out unit | one per referenced type | `groupBy` fn |
| stub identity / path | FQN-keyed, collision-scoped | `path` fn (the runner's conflicting-duplicate error still backstops collisions) |
| which renderer for which node | type-keyed map | accept a **resolver fn**, not only a map |
| `@status` → emission | the §4 table | the renderer receives `status` and decides |
| uncovered-requirement warning | on | suppressible |
| refuse to delete a filled stub | refuse | a force flag |

**Export the primitives, not only the factory** — the requirement walker, the fan-out
helper, the naming helper. Scaffold-and-own means the app owns the file; that is only a
real escape hatch if it can compose its own generator from parts instead of reimplementing
the tree walk.

**Test-framework syntax never enters the library.** The library supplies *data* —
statement, violation, status, referenced nodes, path. The renderer supplies *syntax*. That
is what keeps bun / vitest / jest / pytest / JUnit / xUnit from each being an upstream
change.

**Filters receive a projected shape**, not the raw node:
`{ subType, level, status, path, implementedByTypes }`. Handing over raw `MetaData` binds
app filters to metamodel internals and exports the ADR-0039 own-vs-resolving accessor trap
to every adopter. The cost is that an app cannot filter on anything unprojected; the
projection is additive and can grow.

## 7. Fan-out and naming

**One stub per distinct referenced metadata type** among a requirement's `@implementedBy`
targets — bounded by concern count, not target count.

```
requirement.functional shareableLink
  @implementedBy: Council (object.entity), Council.slug (field.string),
                  Council.slug.view (view.text), slugFormat (validator.regex)
  ⇒ 3 stubs — entity, view, validator
```

The alternative rules are rejected explicitly. *One stub per requirement* cannot give each
concern its own codegen, which is the point. *One stub per referenced node* makes a single
architectural requirement claimed by 123 entities emit 123 stubs — the hostile-first-contact
outcome §10 exists to avoid.

**Naming** is `<requirement dotted path>.<concern>`, FQN-keyed with collision-scoped naming
per ADR-0044's payload precedent. Never bare-name: two requirements sharing a short name
across packages must not collide, which is the defect ADR-0044 exists for.

`@implementedBy` is doing real work here. Round 5 of the requirements investigation found it
worthless **for retrieval** (11/24 with structured links against 12/24 with entities named in
prose). That result stands and does not apply: here it is a *mechanical* codegen input and
the anchor for §8's integrity checks, not a retrieval hint.

## 8. Deletion integrity — both directions

| what is removed | what must be flagged |
|---|---|
| a **requirement** | its generated stubs are now orphans |
| a **node** a requirement claims | the requirement's `@implementedBy` now dangles |

The second already exists as a rule and gets *simpler*: severity was conditional on status
(a dangling reference was allowed on `abandoned`/`superseded`, because those nodes are meant
to be gone). With those statuses retired, **every dangling `@implementedBy` is
unconditionally an error.**

The first needs a rule the draft did not have:

**A stub with a hand-written body must never be silently deleted.** Regen removes an
untouched stub; on a filled one it **refuses, naming the file**. The draft's
`abandoned` → "an existing stub is removed" is safe only for an unfilled stub — on a filled
one it eats assertions someone wrote. Refusing matches this codebase's detect-and-refuse
doctrine (migrate refuses a primary-key move rather than emit something un-appliable, #258)
and is recoverable, where deletion is not.

**Renames are the unsolved edge, and the spec says so.** A requirement renamed at L4 changes
its stubs' identity; three-way merge cannot follow it, so the hand-written body orphans. The
refuse rule makes that *visible* rather than silent, but visible is not solved. A rename
story is required before this is usable on a ledger that churns.

**Hand-written tests naming a removed requirement** are reachable by the identifier scan
`verify` already runs (the mechanism that found the comment-only matches in §1). It should
**warn**, not error — a lexical signal is occasionally wrong, and precision-over-recall is
the existing posture.

## 9. Dogfood — MetaObjects as the first adopter

This repo's most-repeated failure is *a gate existed but did not fire*: six of ten defects in
0.21.4 were invisible to gates that existed for them; the `like` corpus was case-aligned by
construction for several releases; the `ts-slow` lane was red through a release because a
docs-only push skipped it.

The conformance corpus already enforces behaviour across ports — add a fixture and every port
goes red until it complies. What it cannot do is (a) say **why** a fixture exists, (b) detect
that a fixture is **blind** to the rule it claims to test, or (c) surface a ruling with **no
fixture at all**. The `like` fixture is the proof case: it carried a comment stating its data
was case-aligned *"so the test passes whether a port wires LIKE or ILIKE"* — a rationale that
contradicted the actual rule, uncheckable because the rule was written down nowhere the
fixture could be measured against.

Tying fixtures to requirements addresses all three, and **falls out of §6 with no special
case** — MetaObjects is simply another downstream app with its own testing style, registering
two renderers against one requirement:

```
requirement  "like is case-sensitive SQL LIKE in every port"   (ADR-0049)
        ├─ renderer: conformance-fixture  → one shared fixture scaffold,
        │                                    README carrying @statement / @violation
        └─ renderer: port-runner          → one red stub per port (five)
```

That our own hardest case needs no new mechanism is the strongest available validation of §6.

**`@violation` is the de-blinding specification.** The authoring rule already requires a
requirement to state what breaking it looks like — which is exactly the criterion a fixture's
seed data must satisfy. **A fixture that cannot exhibit its requirement's violation is
inadequate by construction.** Stated there, "seed data must include case-mismatched probes"
stops being a lesson learned after a bad release and becomes the fixture's own acceptance
criterion, written beside it. The same applies to interrupted runs for a run-length rule and
order-key ties for a ranking rule.

**Scope: new rulings only, not retroactive.** The §10 hazard applies to this repo too —
retrofitting every existing ruling would produce hundreds of red stubs at once. Start with
whatever the next breaking slot carries.

**Honest limit.** Generating a fixture scaffold does not guarantee a *good* fixture; blind
seed data can still be written into it. What it buys is that the claim and its violation sit
next to the data, so inadequacy is visible in review rather than discoverable only by a
production defect two releases later — the same trade as §11.

## 10. The hazard, and the opt-in it forces

**An adopter with an existing ledger would get one new red test per requirement** — hundreds
on a large estate, 55 on the audited one. That is hostile, and it would get the generator
switched off permanently on first contact, which is the outcome to avoid above all others.

So: **opt-in, per generator and per entry.** A project adds `requirementTests()`
deliberately. New requirements authored after adoption are the natural first users. With
`@verifiedBy` retired (§4), an adopter's pre-existing suite is simply not linked — which is
honest, since that link was never proof.

## 11. What this still does not solve

**A filled-in stub can assert something irrelevant.** The inversion removes the fakeable
*name*, not the possibility of a weak assertion. What it buys is that the claim and the
assertion are co-located and diffable, and that the gradient no longer rewards the shortcut.

The unfakeable formulation remains **`@violation`-driven mutation** — "the named test goes RED
when the violation is real" — which the vocabulary already carries both halves of. It is
deliberately out of scope: `verify` is contractually forbidden from running tests (*"it never
runs them"* is byte-gated in `expected-registry.json` across all five ports), so proving
belongs in a separate opt-in command or an adopter-CI recipe. Generated stubs are the natural
place for it to land later, since a stub can carry its mutation target as structured metadata
rather than the hand-written comments adopters write today.

## 12. Verification — proving the generator works

The gate that matters is not "the generator emitted a file." It is **"the emitted stub
actually fails."** So the tests must **execute the generated code, not grep it** — this repo
has been bitten precisely here, where three defects hid behind text assertions and a golden
file went quiet the moment it was regenerated to match a bad fix.

- a `live` stub, generated and then **run**, exits non-zero — an empty-but-green stub
  recreates the original defect in a new place
- a `planned` stub reports **skipped**, not passed
- filling in the body makes it pass, proving the stub is a real test and not a permanent wall
- **the gate is proven able to fail**: revert the failing assertion and watch the suite go
  green, or the gate is decorative
- a **de-blinded fan-out fixture** whose requirement's `@implementedBy` spans several node
  types, asserting one stub per distinct *type* and not one per node — a fixture touching only
  entities cannot tell the two fan-out rules apart
- deletion integrity both directions (§8): an orphaned filled stub refuses; a dangling
  `@implementedBy` errors
- registry-conformance green in five ports for the §4 vocabulary retirement, with a migration
  fixture proving a legacy `abandoned` / `@verifiedBy` model fails to load

## 13. Open questions

- **Where do stubs live?** A dedicated `tests/requirements/` tree is greppable and easy to
  exclude from coverage; co-locating beside the implementation's tests is more idiomatic per
  ecosystem. With `path` as an app seam (§6) this is a *default* question, not a blocking one.
- **Does a stub reference `@implementedBy` targets by import?** Importing the named entity
  makes the stub fail to compile when the model moves — a stronger link than a doc comment,
  but it couples the test to generated code the requirement may not otherwise touch.
- **Renames** (§8) — the one genuine blocker for a churning ledger.
- **Does the failing-stub default break `meta init`'s first run?** A scaffold that ships red
  is a bad first impression; likely the scaffolded requirements start as `planned` only.
- **Non-TS ports.** The pattern exists in all five, but the fan-out and the projected filter
  shape need a per-port equivalent before this is a cross-port feature rather than a TS one.
