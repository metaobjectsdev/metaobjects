# Ruling — a `test.*` type does not enter the metamodel, and neither does a mutation

**Date:** 2026-08-27 · **Status:** ruled · **Extends:**
[`2026-08-10-requirements-as-metadata-ruling.md`](2026-08-10-requirements-as-metadata-ruling.md)

## The question

`requirement.*` declares a capability claim. Nothing proves the claim is *true*. Three shapes
were proposed to close that:

1. **`test.*` as a registered type**, with `unit | integration | e2e | ui | api` subtypes, nested
   under a requirement or standing alone.
2. **A mutation record** — the edit that must turn a specific check red — as core vocabulary.
3. **Derived mutations** — the toolchain computes a violation from each declared fact.

None of the three enters the metamodel. This records why, and what is being built instead.

## The prior attempt, and its measurement

`@verifiedBy` was this feature. It named the tests said to verify a requirement, and `verify`
checked each named test existed and was not skipped. It shipped in `0.22.0` and was retired in
`0.24.0`.

Two independent measurements of its false-link rate:

| Estate | Method | False links |
|---|---|---|
| A 19-entry ledger | audit of every named test | **4 of 19 — 21%** |
| A 262-entry ledger | grep-link 29 requirements, then read the bodies | **5 of 8 confident matches — 63%** |

The second estate's five: one matched a comment, one a DI key, one tested a different claim, one
tested output where the claim was about source text, one was a docs-drift gate that happened to
contain the token. `verify` was green throughout, in both.

That estate's own design doc states the constraint that governs everything here:

> Any design whose requirement↔test link is a name a human typed is this failure.

`0.24.2` restored `@status: retired` and `@supersededBy` after re-reading the measurement that
removed them. It did **not** restore `@verifiedBy`, on reasoning the FR-039 amendment records as
"independent and unaffected." Nothing below reopens that.

## The discriminator: does it lower?

ADR-0037 decides *how* a concept enters the metamodel — subtype, `@kind`, or attribute. It
assumes the concept belongs in the model at all. The prior question is the product's own thesis:
**one declaration, many lowerings.**

`field.string @maxLength: 50` is declared once and lowered to a column length, a validation rule,
a DTO annotation, a `CHECK` constraint and a form hint, in five languages. That ratio is what
earns a place on the durable spine. Score the candidates by it:

| Candidate | Lowerings from one declaration | Verdict |
|---|---|---|
| `test.unit` / `test.e2e` / `test.ui` | **0** — nothing is emitted differently because a test is a unit test | Not vocabulary |
| A mutation record (`file` / `find` / `replace`) | **1** — exactly that edit, in that file, in that language | Data, not metadata |
| `@counterexample` | **>1** — a doc line, a stub comment, and on `architectural` a real search | Already registered, earns it |

A concept with a 1:1 lowering is data. A concept with a 0:1 lowering is a label.

### The subtype axis is also wrong on its own terms

`unit | integration | e2e` is **scope**; `ui | api` is **surface**. Two axes in one enum is the
defect Amendment 2 of the requirements ruling diagnosed in functional-vs-non-functional before
replacing it with a mechanical discriminator.

And five members that nothing dispatches on is precisely `source.rdb @role`, whose four unused
members were withdrawn in `0.21.0` because *no port ever built the routing they anticipated*.
ADR-0007 Amendment 2 set the re-entry bar: **a member enters the registry only when a shipping
consumer dispatches on it.** A `test.*` subtype clears no part of that on day one.

## The model-level mutation, and the counterexample that killed it

The most promising escape from "a mutation is a repository fact" was to mutate the **model**
instead of source: perturb a declared fact, regenerate, and require the check to redden. No file
paths, no source text, cross-port by construction, entirely within what the metamodel owns.

It fails on the very claim that motivated the work. In the 262-entry estate,
`botCanBeRetiredWithoutErasingItsResults` is implemented by a `status` field, and the test grep
linked to it asserts that `status` *defaults to `active`* — one of the five false links above.
Delete the field and that test goes red. A model-level mutation scores it **KILLED** and is
wrong: it proved the test touches the field, never that the test tests the claim.

The principle that survives:

> A vacuity proof must be **as narrow as the claim**. The metamodel's finest grain is a declared
> member. A behavioural claim is finer than any member. So the metamodel cannot express a
> narrow-enough mutation for the claims that carry the value.

The shipped harness in that estate states the same requirement from the other side: the
replacement must be *"a plausible bug, as narrow as the claim."*

## Why the two working implementations disagree

Two adopters independently built a mutation harness, and they do not agree on what a mutation is.
One authors source edits (`file` / `find` / `replace` / expected-red test titles). The other
derives them: *each declared relation knows what a violation of itself looks like*, so a newly
declared fact arrives with its proof attached — 36 mutations, 36 of 36 forcing a failure.

The divergence is structural, not stylistic. **Derived mutations work when the claim's subject
*is* the declared model.** The second adopter is a tool whose domain is its own declarations, so
the claim grain and the model grain coincide. The first adopter's claims are about product
behaviour and its model is the data layer underneath, so they do not.

Core cannot tell which kind of project it is being used by, which is the strongest argument
against shipping either form as the one true shape.

## The derived tier is noise for the ordinary case

A derived mutation over a declared constraint — write `null` into a `@required` field, 51
characters into a `@maxLength: 50` — tests whether code MetaObjects generated from fact X
enforces X. That is a conformance test of the library, which the five-port corpus already runs.
The adopter learns nothing about their own code.

The 262-entry estate reached this independently and wrote it into its non-goals:

> **No metadata-fact assertions** (field exists, reference resolves). `meta verify` already proves
> referential integrity; such tests are green with no information and would dilute the real ones.

It then names the test asserting column defaults as exactly that shape — and it is one of the
five false links. A tier the most invested adopter classifies as dilution is not a core feature.

## The asymmetry that looked like the gap, and its deflation

The two requirement subtypes carry opposite checks: `functional` fails when **nothing** implements
it (existence); `architectural` fails when **something violates** it (universality). Only the
second is a falsification search, and the registry says why — an architectural counterexample is
*"the node that would contradict it,"* a shape the loader can hunt for.

That suggested the real gap was not missing vocabulary but an underexploited one: push functional
claims toward model-shaped counterexamples and the proof becomes free.

**Checked against the estate, and it deflates.** Half of "a bot can be withdrawn while the hands
it played stay on the record" *is* model-shaped — it is the referential action on the reference,
registered on `identity.reference` since `0.21.6`. That estate declares **116
`identity.reference` nodes, 19 `relationship.association`, and zero `@onDelete`, zero
`relationship.composition`.** The vocabulary that would make half the claim structurally true and
mechanically checkable exists, ships in five ports, and is never declared.

So this is an under-declared model, not a metamodel gap. It is recorded here because it is a real
finding and because it is the kind of observation that becomes a feature proposal if nobody writes
down that it was checked.

## What is actually broken, and is being fixed instead

`meta verify --codegen` is hostile to the hand-edited generated output the product explicitly
sanctions. Reproduced on a clean `0.24.2` install:

```
meta gen                  → src/generated/Bot.ts, merged      the hand edit is preserved
meta verify --codegen     → ~ src/generated/Bot.ts (committed content differs from a fresh regen)
                            Run 'meta gen' to regenerate, then commit the result.
                            exit 1
meta gen && meta verify --codegen                             exit 1
```

`computeCodegenDrift` regenerates with `mergeStrategy: "overwrite"` and `baseline: "fresh"` into a
throwaway gen-state directory, then byte-compares against committed output. It cannot see the
three-way merge, there is no exclusion mechanism, and **its own printed remedy is a loop.**

This is not incidental to the question. It is one of the three adjudicated reasons the 262-entry
estate did not build its requirement-test generator, and requirement stubs are the worst-affected
case: a generated stub is worthless until hand-edited, because the assertion is the author's to
write.

The fix is in [`2026-08-27-codegen-drift-hand-edits-design.md`](2026-08-27-codegen-drift-hand-edits-design.md).

## Re-entry bar

This ruling is reversed by evidence, not by argument. Any of:

1. **A shipping consumer dispatches on a test kind** — some generator, check or runtime emits
   different output because a test is `e2e` rather than `unit`. Then the subtype axis has a
   reader, per ADR-0007 Amendment 2.
2. **A third mutation harness appears whose shape agrees with one of the first two.** Two
   disagreeing instances is not a generalisation; three with a majority is a candidate.
3. **A production prevention case for the mutation tier** — a mutation that survived, was
   adjudicated a genuine toothless test, and caught a defect before release.

## What is not claimed

- **Not that proving requirements is worthless.** One adopter reports 16 of 30 claims proven and
  a coverage gate on the remainder, blocking at pre-push. That mechanism works. It works *in that
  repository*, which is the point.
- **Not that mutation testing is the wrong idea.** It is the right idea in the wrong location.
  The metamodel owns the model; a mutation is a fact about a repository.
- **Not that `@counterexample` is in good shape.** It is prose, in a product whose thesis is that
  prose is not checkable, and that tension is real. It is not being fixed: a structured
  counterexample is a behaviour-description language, and a custom DSL is a chartered non-goal.
  The limit is recorded rather than closed.
