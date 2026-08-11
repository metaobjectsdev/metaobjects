# Requirements as metadata — investigated, ruled, closed

_2026-08-10. Five controlled rounds, 52 independent fresh-context agents._

**Ruling: do not add requirements vocabulary to the metamodel. The artifact that works is
a plain YAML capability ledger with a `status` field, and it needs nothing from MetaObjects.**

This document exists so the question is not re-opened without new information. It records
what was tested, what fired, and — deliberately — every place the investigation's own
author was wrong, because those were the most informative results.

## The proposal

Model software requirements as first-class metadata alongside the entity model, linked to
the nodes that satisfy them (`satisfies:` on a field/entity, `modelRef:` back), then use
those links for drift detection, gap auditing, documentation, and — the motivating claim —
to stop an LLM re-implementing a capability the system already has.

## What was tested

| Round | n | Question |
|---|---|---|
| 1 | 12 | Which requirement *shape* can an LLM author consistently? (4 shapes × 3) |
| 2 | 8 | Forward/greenfield authoring, with and without authoring guidance |
| 3 | 5 | Maintenance through 3 changes, vs a control with all tags stripped |
| 4 | 4 | Analysis of a 128-entity legacy estate, requirements-assisted vs model-only |
| 5 | 12 | **Duplicate prevention** — 8 feature briefs × 4 arms |
| — | 11 | Ledger construction, adjudication, verification |

Rounds 3, 4 and 5 all carried a **control** and **pre-registered kill conditions**.

## What fired

**Round 3 — the mechanical benefits are matched by a control.** Given three change
requests, agents with the requirements graph and agents with only the model performed
identically on orphan removal, dangling-reference cleanup after a rename, and — the one
all three requirements runs claimed as a benefit — documenting a database guarantee lost
in the change. The control did that unprompted. The recorded rationale that produced the
best judgment call turned out to be available to the control too, as a **YAML comment**.

**Round 5 — retrieval needs no ledger at all.** Given eight feature briefs phrased in
product language deliberately unlike the model's vocabulary, the model-only arm found
every existing implementation on all three reps, and correctly built new for both novel
controls with zero false reuse. There was no duplication problem to solve: **agents already
reuse.** The motivating claim is refuted.

**Round 5 — the links are worth nothing.** Arms differing only in whether the ledger
carried a structured `implementedBy` list scored **11/24** (with links) and **12/24**
(links stripped, entities named in prose). The arm without the vocabulary scored higher.

**Round 5 — delivery method is worth nothing.** The arm merely *told* a ledger file
existed opened it unprompted in both reps and matched the arms that were directed to it.

## What survived

One thing, and it is not what the proposal was about.

**Model-only: 0 of 24. Ledger arms: 19 of 40.** Every run with a ledger caught that the
requested capability had been *deliberately retired*; no run without one did. All three
model-only runs proposed to extend an abandoned feature, in near-identical words, each
believing it was reusing rather than reviving.

The failure prevented is not duplication. It is **resurrection** — and a retired feature is
*more* attractive to a retrieval-driven agent than a live one, because it was purpose-built
for exactly the request and never got complicated by contact with production. One run named
it: *"a near-exact decoy."*

The model cannot encode this. A comment reading "never by turn timers" sits on a different
node from the fields being revived; nothing connects the disproof to the thing being
resurrected. A ledger entry with `status: abandoned` does exactly that, in one line.

## The ruling

1. **No metamodel vocabulary.** No `satisfies:`, no `modelRef:`, no `requirement.*` type,
   no ADR-0037 proposal, no registry change, no cross-port fan-out. The kill condition was
   pre-registered and it fired.
2. **A capability ledger is a schema'd project artifact, not ad-hoc YAML.**
   `metaobjects/capabilities.yaml`, with the schema **shipped by the CLI** and validated by
   `meta verify` when the file is present:
   - `status` is a **closed enum** — `live | partial | abandoned | superseded` — and an
     unknown value is a hard error. This is the one payload with controlled evidence behind
     it; leaving it as an unchecked string would let a typo silently disable it.
   - `implementedBy` is optional, name-checked against the **loaded model**, with severity
     **conditional on status**: a dangling reference on `live`/`partial` is an error (the
     model moved and the ledger is stale); a dangling reference on `abandoned`/`superseded`
     is **allowed**, because those nodes are supposed to be gone — that is the point of the
     entry. Only the loader knows every FQN, which is why the product, not a convention,
     has to be the validator.

   The ledger's schema is **reserved, not registered** (the ADR-0040 treatment). It enters
   the metamodel registry only when a shipping consumer *dispatches* on capability records,
   per the ADR-0007 Amendment 2 bar. Nothing does today.

   _Amended 2026-08-11._ As first written, this point said the ledger was a bare project
   convention needing nothing from MetaObjects. That was wrong, and the objection is worth
   recording because it is a better argument than the one it corrected: **the ledger has a
   schema — a closed enum and a list of FQN references to model nodes — so hand-rolling it
   reintroduces every failure this project exists to prevent.** The round-5 kill fired on
   *node-level back-links* (`satisfies:` on fields and entities) and on the retrieval value
   of structured links. It was never evidence against the ledger having a validated schema.
   The original wording conflated the two.
3. **Cleanup is a procedure, not a product.** Usage evidence — grep every declared table and
   field name across the source — found 15 dead objects where the best LLM analysis found 6.
   Ask the code, not the model, and never the requirements.
4. **The one thing worth considering in-product** is unrelated to requirements: a
   `supersededBy` that *resolves* (FQN-checked, so `verify` can fail on a dangling one),
   turning "deleted in S6" from an inert comment into a build gate. It should still be
   earned by a shipping consumer first, per the ADR-0007 Amendment 2 bar.

## Where the investigation was wrong

Recorded because the corrections were more useful than the confirmations.

- **"Level is nesting depth."** Derivable but not meaningful — depth encodes the author's
  grouping, not importance. Falsified 3/3.
- **"Functional vs non-functional is the subtype axis."** Falsified 9/9 — but see the
  amendment below; what failed was the *discriminator tested*, not the axis.
- **"One subtype is enough."** Overturned by an agent citing ADR-0037 against it.
- **A regex used to build a control** deleted sibling node headers; duplicate YAML keys
  parsed silently and two control runs were spent repairing the damage. Discarded and re-run.
- **"The ledger inflates scope 4–6×"** — asserted from two runs, retracted when the third
  proposed the same count as the control. Within-arm variance exceeded between-arm.
- **Round 4 was presented as evidence for the feature.** Its independent variable was
  document availability, not links. An external review caught it; the correct state at that
  point was *refuted on every tested claim, untested on the crux*.
- **A pre-registered kill fired in round 3 and the response was to change the setting and
  re-run.** Naming it here because it is the failure mode most likely to recur.

## Amendment 2 (2026-08-11) — the functional/architectural axis, and testing

The reversal above ("functional vs non-functional is the wrong axis") is **too broad as
written**. Nine runs falsified the discriminator I gave them — *"non-functional = carries a
measurable target"* — which collapsed into "did I find a number." A different discriminator
was never tested and is materially better:

> **Functional** = what the product does for a user.
> **Architectural** = how the system is built, applied uniformly across the model.

A uuid primary key, an `@autoSet createdAt`, an `updatedBy` audit column, tenant scoping —
these are not quality attributes with thresholds. They are **architectural policy**, and the
discriminator is mechanical: did this exist because someone asked for something, or because
every entity here looks like this?

**Why the axis is real: the two halves need opposite checks.**

| | check | fails when |
|---|---|---|
| functional | **existence** — ≥1 node implements it | nothing implements it |
| architectural | **universality** — no node violates it | one entity lacks the uuid PK |

That is a genuine child-licensing / behaviour difference, which is what ADR-0037 asks for.
An architectural requirement needs no threshold and no test; it is proven structurally by
`verify`. Proof already in hand: `BaseEntity` has 26 extenders, `BaseTenantEntity` 9, and
**`BaseAuditedEntity` zero** — an architectural requirement with no implementers, which four
independent analyses had to discover the hard way and a universality check would have failed
the build on.

**It also dissolves the field-grain ceremony objection.** Requiring 1,353 fields to cite a
capability sounded like noise (`id` → "the system stores things"). Under this split the
plumbing fields collapse onto a *handful* of architectural requirements with very high
fan-out — one uuid-PK requirement claimed by 123 entities, one change-attribution
requirement, one tenancy requirement. Roughly 120 functional plus ~12 architectural, not
1,353 meaningless links.

**Anti-garbage rule, for the authoring skill.** A requirement must be **violable**: state
what breaking it looks like. *"Every entity has a uuid primary key"* is violable — point at
one with a composite string key. *"Things are persisted"* is not, and is therefore a
description, not a requirement. Same rule kills *"the system is reliable."*

**Many-to-many is structural, not optional.** A node is claimed by whatever capabilities name
it in `implementedBy`, so multi-claim needs no vocabulary — and the split makes it the normal
case, since every field participates in architecture and product at once. `Council.id` is
claimed both by the uuid-PK requirement and by a functional requirement about shareable,
human-transcribable links.

**Testing follows the same split, and shrinks by an order of magnitude.** Architectural
requirements take **no tests** — `verify`'s universality check is the proof. Only functional
requirements need one, so the surface is ~120 rather than ~1,350. A functional requirement
carries `verifiedBy`, and `verify` checks the named test exists and is not skipped — a symbol
lookup over an identifier index, the same mechanism the usage-evidence pass already performs
across 3,700 files in seconds. This is the correct boundary for the case round 2 could not
resolve: *"nothing in the metadata encodes 'the offer goes to the first row'; that is
selection logic."* Metadata proves shape, `verify` proves architecture, a test proves
behaviour.

None of this reinstates node-side `satisfies:`. The round-5 kill stands: links live on the
ledger, not on fields.

## Do not re-run

Rounds 1–4 answered shape, guidance, maintenance and analysis. Round 5 answered retrieval
and status with a control and pre-registered kills. Re-open only with genuinely new
information — a port where the model carries no descriptions or comments (all four rounds
found those load-bearing), or a shipping consumer that dispatches on `supersededBy`.

Raw agent output is session-scratch and not preserved. The reproducible artifact from this
work is the usage-evidence method in §3, which is committed in the adopter repo where it
was developed, not here.
