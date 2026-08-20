# Two contracts, two numbers — versioning after 1.0

**Status:** design, for ratification. Amends [ADR-0035](../../../spec/decisions/ADR-0035-one-zero-stability-commitment-and-version-unification.md) §1–§2 and `docs/compatibility-policy.md`.
**Date:** 2026-08-20
**Scope:** policy only. No loader work, no deprecation windows, no new vocabulary.

## The problem, measured

`v0.5.0` (2026-05-22) → `0.23.2` (2026-08-17) is **19 minor lines in 87 days** across
90 tags — a new minor roughly every 4–5 days. Doug's summary of where that leads —
*"we'll be on 100.100.0"* — is not hyperbole; it is the current rate extended.

The rate itself is not the defect. Most of those minors were correct calls under the
rule in force at the time. The defect is **what the rule attaches the number to.**

Today, one number carries two unrelated promises:

1. **The software surface** — the imports, CLI flags, generated-code shape and runtime
   helpers an adopter's *build* depends on.
2. **The metamodel** — the registered vocabulary, canonical format and wire contract an
   adopter's *metadata* depends on.

ADR-0035 §1 binds them: a breaking change to the metamodel "bumps the spec version's
major (Metamodel 2.0) **and forces a major on every affected package**." So one
vocabulary retirement — `@readOnly`, `@verifiedBy`, `@unique` — drags npm to `2.0.0` and
Maven to `9.0.0`, and the package majors become a running count of metamodel edits
rather than a statement about the software.

That is already shaping decisions. The ADR-0052 roadmap correction (2026-08-19) had to
rule that a post-1.0 `1.1` MINOR **cannot** carry FR-037's or FR-038's vocabulary
retirements, because ADR-0035 §1 makes each a 2.0 event. The rule is working exactly as
written; what it produces is a project that reaches 1.0 and then has to spend a major on
its next housekeeping edit.

## The decision

**Split the promises, and give each its own number.**

| Number | Promises | Moves when |
|---|---|---|
| **Package version** (npm/PyPI/NuGet `1.x`, Maven `8.x`) | the SOFTWARE surface: exports, CLI flags, generated-code shape, runtime helpers | that surface changes — full SemVer, `2.0.0` / `9.0.0` for a break |
| **`metamodelVersion`** (`"0.9"` today, `"1.0"` at the cut) | the METADATA contract: registered vocabulary, canonical authoring + interchange format, wire/normalization contract | that contract changes — its own major for a break |

**A metamodel-vocabulary break moves `metamodelVersion`, and does NOT force a package
major.** That clause of ADR-0035 §1 is severed.

`metamodelVersion` is not new. It has shipped in all five ports since PR #145 as the
first key of the byte-gated `expected-registry.json`
(`RegistryManifest.METAMODEL_VERSION` / `METAMODEL_VERSION` / `metamodelVersion`). ADR-0035
§2 already decoupled it from package coordinates and made it the cross-language parity
signal. This design does one further thing: it makes that number **load-bearing for
compatibility**, not merely descriptive of it.

### What a package MINOR means, restated

`docs/compatibility-policy.md` currently says a MINOR is "Additive; never breaking." That
becomes:

> **MINOR** — adds surface a consumer can newly depend on. Never breaking **on the
> software surface**. A release that breaks the METADATA contract also moves
> `metamodelVersion`, and says so in the changelog; the package coordinate is not where
> that fact lives.

### Cadence is a separate lever, and it is free

Nothing forces one release per merged change. Batching a fortnight of work into one
coordinated cut costs nothing and removes most of the number pressure on its own. The
19-minors-in-87-days figure is as much a cadence artifact as a policy one, and cadence
needs no ADR to change.

## What this costs, stated plainly

**It trades a mechanical gate for a social one.**

Pre-1.0, the caret rule is a real gate: `^0.22.x` resolves `<0.23.0`, so a consumer
adopts a MINOR deliberately. That is why `0.21.0` and `0.23.x` could ship metamodel
changes safely. **Post-1.0 that gate disappears** — `^1.0.0` accepts `1.1.0` — and the
package MAJOR becomes the only coordinate a resolver will refuse to cross. Severing the
"metamodel break ⇒ package major" link therefore removes the only *mechanical* protection
an adopter has against auto-adopting a metadata break on a routine update.

What replaces it, today, is that **every adopter is reachable**: six projects, all
Doug's, all upgradeable by hand. That is a true statement about 2026 and a coherent basis
for the trade. It is also a premise with an expiry date, so it is written down here rather
than left implicit.

**Why no loader check today.** The obvious mechanical replacement — the loader refusing
metadata declared for an incompatible metamodel version — is deferred deliberately, and it
is more expensive than it looks: `metamodelVersion` is currently a property of the
LIBRARY, and there is nowhere an adopter declares *"my metadata targets Metamodel 1.0."*
Adding that declaration is new vocabulary in all five ports plus a compatibility matrix —
real work, gating a hazard that six reachable adopters do not have.

### Deferred, with triggers

| Deferred | Adopt when |
|---|---|
| **A declared metadata target + loader/verify compatibility check** — the mechanical gate above | the adopter set stops being enumerable and reachable: a metamodel break ships to someone who cannot be told in advance |
| **Per-item `experimental` / `stable` markers** (the Kubernetes model) | a member needs to ship for feedback without entering the frozen set — today the reserved-not-registered treatment (ADR-0007 Am. 2, ADR-0040) already covers this |
| **Editions** (the Rust model) — a per-model opt-in that pins old semantics | two metamodel majors coexist in one estate and pinning per model beats upgrading per repo |

## Prior art

- **OpenTelemetry** — spec version (1.5x) is the coordinating contract; each language SDK
  versions independently against it, with a compliance matrix. Already the model ADR-0035
  §2 adopted; this design finishes the job by letting the two numbers move independently
  in *both* directions.
- **Rust editions** — the language breaks; the compiler version does not. A per-crate
  `edition` key opts in. The precedent for "a breaking change to the *language* is not a
  breaking change to the *tool*."
- **Kubernetes** — `alpha`/`beta`/`stable` per API object with a published deprecation
  window per tier, rather than one project-wide major. Rejected for now as the wrong shape
  at six adopters; retained as a trigger above.
- **TypeScript** — explicitly does not follow SemVer, and says so, because every release
  can break inference. The honest-labelling precedent: it is better to state the real
  contract than to encode a false one in the number.

## What changes in the repo

Policy only — no product code.

1. **ADR-0035 §1** — sever "and forces a major on every affected package"; state the split
   and its cost; add the deferral triggers as an amendment.
2. **`docs/compatibility-policy.md`** — the two-number table, the restated MINOR, and an
   explicit sentence that **package 1.0 does not freeze the metamodel**.
3. **`docs/RELEASING.md`** — the post-1.0 column of the versioning table stops reading
   MAJOR for metamodel changes; add the `metamodelVersion` row.
4. **`spec/roadmap.md`** — the "what the next breaking MINOR carries" section (added
   2026-08-19) gets the post-1.0 rule beside it.

## Open question for ratification

**Does the next breaking batch go before or after the 1.0 cut?**

Before is cheaper: pre-1.0 the caret rule still gives adopters a real gate, so FR-037,
FR-038, ADR-0052 and ADR-0053 can all land in one deliberate MINOR with the mechanism the
project already trusts. After means the first exercise of this new policy is also the
first time the mechanical gate is absent.

This design does not settle it — it is a schedule call, not a policy one.
