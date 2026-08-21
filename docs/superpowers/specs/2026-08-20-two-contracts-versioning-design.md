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

## Enforcement — the number has to actually move

**Added 2026-08-21, after measuring.** The decision above hands the compatibility promise
to `metamodelVersion`. It was worth checking whether that number had ever moved: it has
read `"0.9"` since it shipped in PR #145 on 2026-07-02 and stayed there across **57
releases** — including `0.21.0`, the deliberate pre-1.0 breaking slot that retired
assembly origins from `object.value` and shrank `@role`, and `0.22.0`, which added a whole
registered type family. Today it is a label, not a version. A promise carried by a number
nobody maintains is not a promise.

So the amendment ships with the gate it implies:
**`scripts/check-metamodel-version.mjs`**, registered in `ci-local.sh`'s `gates` lane.

- **Baseline: the last release tag.** The version promises against what adopters actually
  have — and a per-commit baseline would demand a bump from every PR in a release cycle
  rather than the first one. This is the `buf breaking --against '.git#tag=…'` /
  `oasdiff` shape: compare the artifact to its released baseline, classify, require the
  declared version to match.
- **Subject: `expected-registry.json`**, which is already the byte-exact bill of
  materials every port is gated against. No new artifact.
- **Classification is structural** — types, attrs (`required` / `valueType` / `isArray` /
  `allowedValues`), child rules (`min` / `max`), default subtypes. Removal and narrowing
  are breaking; addition and relaxation are additive.
- **Pre-1.0 a breaking change moves the MINOR**, for the same reason the package line
  does while it is `0.x`.
- **`--set <version>` writes all five declaring sites at once** (the manifest plus four
  port constants; Kotlin emits through the JVM's). A partial edit is caught by
  `registry-conformance` — verified by reverting one port's constant and watching it
  fail — but only in that port's lane, so the ergonomic path avoids the hazard entirely.
- **A missing baseline FAILS.** This repository has 90 release tags; the only way to see
  zero is a checkout that did not fetch them, and a baseline-less run would pass
  unconditionally — a green tick that checked nothing.

### The blind spot, stated

A rule can change with **no machine-readable footprint**. #210 is the proof: retiring
assembly origins from `object.value` was a breaking metamodel change whose only manifest
edit was the `rules` PROSE string. The loader enforced the new rule; the structured
vocabulary was untouched.

So prose changes (`description` / `rules` / `whenToUse`) are reported as a **warning with
a direct question** — *did the RULE change, or only its wording?* — not classified. A typo
fix and a semantics change are indistinguishable there, and failing on every wording edit
would train people to ignore the gate. Answering that question is a human step in every
release, and the gate says so each time rather than pretending it covered it.

### What it caught immediately

Run against `v0.23.2` on the first commit after ADR-0052 merged, it failed: `@promptStyle`
removed from `template.output` (breaking), `@promptStyle` + `@responseFormat` added to
`template.prompt` (additive) — with `metamodelVersion` still `"0.9"`. The version moved to
`"0.10"` as part of adding the gate.

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
