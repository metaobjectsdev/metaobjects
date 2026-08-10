# Metamodel gaps surfaced by the requirements-modeling spike

_2026-08-10. Findings doc — observations, not a design._

## How these were found

A design spike ran 20 independent fresh-context agents at the question "can software
requirements live in the metadata?". Eight of those runs were **greenfield**: given a
one-page stakeholder brief for a small allotment-tenancy register, each derived a
requirement set and then authored the MetaObjects model that satisfies it.

The gaps below are a **by-product**. None was prompted for; each surfaced because an
agent was trying to *express a real rule* and could not, then said so. They are
independent of whether requirements-as-metadata is ever built.

The value of the provenance is that these agents were not looking for metamodel
holes — they were trying to finish a modelling task and hit a wall. The replication
counts are out of the 8 greenfield runs.

Each gap is read against [ADR-0037](../decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
below, but no gap here is proposed for adoption. Several may be correctly refused.

---

## G1 — `origin.*` has no window / ranking construct (8 of 8)

**The case.** The brief's single most important rule is a queue: an offer goes to the
longest-waiting applicant, ties broken by a second key. A projection therefore needs
each row's **position** — `ROW_NUMBER() OVER (ORDER BY …)`.

`origin.aggregate` reduces a set to one value. `origin.computed`'s `@expr` grammar is
closed and row-local. Neither expresses a rank, and there is no `origin.window` /
`origin.rank`.

**Consequence.** Every run fell back to the ADR-0043 `source.rdb @sql` escape — which is
the sanctioned valve, but `@sql` then forbids `origin.*` children *and* the object-level
`@filter`, so the whole projection becomes hand-written SQL. Two runs stated the cost in
almost identical words:

> "The one rule the officer says the scheme lives or dies on is the one place the
> metadata is not the single source of truth."

> "The declarative chain broke exactly at the most-argued-over rule rather than at the
> periphery."

**ADR-0037 read.** Not derivable (step 0) — no combination of existing origins produces a
rank. Not physical (step 1). It has its own semantics and its own required
configuration (partition keys, order keys, direction), which points at a **subtype**
(`origin.rank` or a windowed `origin.aggregate`), not an attribute. Note the interaction
with #211's backend-agnostic materialization: a rank has meaningful lowerings outside
RDB, so it should be designed with that lens rather than as a Postgres passthrough.

**Also note the escape-valve composition problem** this exposes, which is worth fixing
even if G1 is refused: `@sql` is all-or-nothing at the projection level. A projection
needing *one* irreducible column must hand-write *every* column. A per-field escape
would have contained the damage in all 8 runs.

---

## G2 — no forbidden-combination validator (5 of 8)

**The case.** "An overgrown or out-of-service plot cannot be let." That is
`NOT(condition = OVERGROWN AND status = LET)` — a negated conjunction across two fields
of the same object.

The registered validator vocabulary is `comparison` (relational), `requiredWhen` /
`presentIff` (presence-only), and `atLeastOne`. None states a prohibited combination of
*values*.

**Consequence.** The rule has no node that enforces it. Runs tagged it onto the fields
and the index that *feed* it, which — in one run's words —

> "overstates what the model actually guarantees."

A second run noted the same gap forced two `requiredWhen` validators where one
"when outcome is not PENDING" would have done, so the gap also produces redundant
declarations in the cases it *can* almost express.

**ADR-0037 read.** Behaviour of its own, own configuration ⇒ **subtype**
(`validator.forbiddenCombination`, or a general predicate validator over an
`attr.filter` AST — the AST already exists and is cross-port, which makes the second
form cheap and reuses #207's machinery).

---

## G3 — no run-length / gaps-and-islands aggregate (4 of 8)

**The case.** "Two Neglected inspections in a row triggers a warning; three takes the
plot back." The trigger is the length of the current run of a value in an ordered
sequence.

`origin.aggregate`'s `@agg` set (count/sum/avg/min/max/any/all/collect/first) has no run
operator, and a run is not expressible as an aggregate over a filter.

**Consequence.** Runs resolved it three different ways — a snapshot counter column on the
parent, an `origin.first` over the latest grade plus an index, or prose plus a
supporting index. All three are denormalised state that can drift from the inspection
rows that are supposedly authoritative. This is the shape most likely to be
**silently wrong** in a real adopter model.

**ADR-0037 read.** Genuinely hard. A run-length is a window function (see G1) and would
likely fall out of G1 rather than needing its own vocabulary. Worth treating as a G1
acceptance case rather than a separate feature.

---

## G4 — no write-once / immutable-after-create field (2 of 8)

**The case.** An application's date of record and an inspection's evidence trail must be
"settable once, never rewritten". `@readOnly` means *never* settable, which is a
different thing — it excludes the create path too.

**Consequence.** One run carried it as a comparison invariant plus an amendment-note
field; another as prose. Neither is enforced by the generated write surface.

**ADR-0037 read.** This modifies an existing type's write behaviour without changing its
children ⇒ **attribute**. It is a natural sibling of ADR-0045's `@autoSet` — that ADR
already establishes that the generated API surface owns write semantics, and already
excludes `@autoSet` fields from the settable set on PATCH. A `@writeOnce` would use the
same machinery: settable on POST, excluded on PATCH. That makes it unusually cheap.

Note the overlap: an `@autoSet: onCreate` field is *already* write-once by construction.
`@writeOnce` is the caller-supplied counterpart, so the two should be specified together
or the pair will drift.

---

## G5 — no state-transition construct (2 of 8)

**The case.** "A plot becomes vacant when its tenancy ends." The `field.enum` holds the
state set; nothing holds the legal transitions or their triggers.

**Consequence.** Untaggable, and unenforced. Runs either dropped the requirement or
tagged the enum, which one flagged as padding since the enum exists for a different
requirement.

**ADR-0037 read.** Deliberately parked. A transition model is a large feature with a
long tail (guards, effects, concurrency) and it overlaps the FR-024 declared-API surface
(`operation.command`) — a transition is arguably a command's post-condition, not a field
property. It should not be designed from a requirements spike. Recorded here only so the
next person to propose it knows it has been hit in practice.

---

## G6 — no access-control vocabulary (3 of 8)

**The case.** The brief distinguishes three audiences: an officer, two or three committee
members with read access, and the public. Every access requirement was untaggable.

`api.*` is chartered by ADR-0030 but **unregistered**, and FR-024's declared-API surface
is deferred to 1.1, so there is no node an authorization requirement can attach to.

**Consequence.** In every run, all access requirements clustered in the untagged tail.
This is not a new gap — it is the known FR-024 deferral — but the spike shows it is the
single largest *category* of requirement the metamodel cannot currently reach, which is
useful sequencing information for 1.1.

**ADR-0037 read.** Blocked on FR-024, not independently actionable.

---

## Cross-cutting observation: what the untagged tail is actually measuring

Across the greenfield runs, the requirements that could not be traced to any metadata
node clustered into exactly four groups, and only the last is a defect:

1. **Deliberate exclusions** — satisfied by the *absence* of a node, structurally untaggable.
2. **Goals with no acceptance measure** — nothing to point at, by definition.
3. **Requirements outside a data metamodel's reach** — deployment, offline capture, printing.
4. **Requirements the metamodel cannot yet express** — G1–G6 above.

One run put the general form of this well:

> "Tag coverage is a measure of what the metamodel can express, not of requirement quality."

That sentence is worth keeping regardless of what happens to requirements-as-metadata: it
is the correct caveat on **any** coverage metric this project ships, including
`meta verify`'s existing ones.

## Cross-cutting observation: coverage metrics are biased against hard rules

G1, G2 and G3 share a failure mode. When a rule cannot be declared, it still gets
*tagged* — onto the fields, indexes and columns that feed it. So the rule appears
covered while nothing enforces it:

> "Tag counts overstate coverage for exactly the rules that are hardest to get right."

Any coverage-style gate must therefore distinguish "a node realises this" from "a node is
adjacent to this", or it will report highest confidence exactly where confidence is least
warranted.

---

## Status

None of these is scheduled. G4 is the cheapest and most obviously correct (it composes
with ADR-0045). G1 is the highest-impact and should be designed with #211's
backend-agnostic lens. G2 is cheap if built on the existing `attr.filter` AST. G3 likely
falls out of G1. G5 is parked. G6 is FR-024.

The escape-valve composition problem noted under G1 — `@sql` being all-or-nothing per
projection — may be more valuable than any single gap on this list, since it bounds the
blast radius of every future irreducible column.
