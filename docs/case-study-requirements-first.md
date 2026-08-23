# Requirements-first with MetaObjects: a measured case study

*2026-08-23. Written against `axi-core`, a new Python package, using the MetaObjects 0.24 line.*

This is a record of one thing that worked, with the numbers behind it and the boundary around
it. It is deliberately specific: the interesting result is not "MetaObjects is good for
requirements" but *why the same approach failed on an existing codebase and succeeded on a new
one*, and what changed in between.

---

## Summary

A new package declared its requirements in MetaObjects **before** it had an implementation, and
generated its conformance checks from that declaration.

| Measure | Value |
|---|---|
| Declaration | 488 lines |
| Requirement nodes | 22 — 17 functional, 5 architectural; 18 leaf, 4 parent |
| Requirements carrying `@implementedBy` | 17 |
| Generated checks | 24 (one per declared fact member) |
| Generated test module | 25 functions (24 named + 1 parametrised vacuity), 48 collected cases |
| Whole suite | 487 passing |
| Projection kinds used | 4 of 4 — capability 9, population 3, wire 8, differential 4 |
| Checks needing credentials or network | **0 of 24** |
| Vacuity: automated mutations | 36 across the 24 checks, **36/36 force a failure** |
| Vacuity: deliberate source breaks | 10, **10/10 caught by exactly the expected check set** |

The last two rows are the ones worth arguing about, and they are covered in detail below.

---

## Background: two earlier verdicts, and which one was wrong

Two sibling command-line tools, `ha-axi` and `plex-axi`, were built without any of this. Both
later attempted requirements traceability. Both attempts produced a negative verdict, and only
one of those verdicts was correct.

### The correct verdict: labelling is not verification

The first attempt linked each requirement to the tests that were said to verify it. It was
measured against a commit where two requirements had shipped **broken**. At that commit:

- the suite was **413 tests passing**;
- one broken requirement carried **two** requirement-labelled tests;
- the other carried **three**.

The link was present, labelled, and green while both requirements were false. A label records an
*intention* that a test verifies a requirement; nothing checks whether it does. MetaObjects
retired `@verifiedBy` in 0.24.0 for this reason, and that retirement was right.

### The incorrect verdict: "MetaObjects cannot express this"

The second attempt concluded MetaObjects could not express a requirement's oracle — the statement
of what the correct answer actually is — because there was no attribute for one. It invented an
attribute, received `ERR_UNKNOWN_ATTR`, and recorded the tool as a poor fit.

That was a **modelling error, not a tool limitation**, and it is worth stating plainly because it
is an easy one to repeat:

> `@implementedBy` is legal at **L4/L5 only**, and **L5 names a member** — a field, a view, a
> validator, an identity, or a template's child.

So a live-system fact is not an annotation hung off a requirement. It is modelled as an object,
a field, or a validator, and the requirement **tags that member**. No oracle attribute is needed
because the member *is* the oracle. Once the model is built that way, the expressiveness
objection disappears entirely.

Anyone reaching for a new attribute to hold a requirement's expected value should treat that
impulse as a signal that the fact has not been modelled yet.

---

## What replaced labelling: generation from the declaration

The approach that survived measurement generates checks from the declaration rather than
labelling hand-written ones.

### Run the same *projection* twice, not the same assertions twice

An early hypothesis was "run the assertions against a test double and again against a real
system." That does not generalise, and the reasons are worth recording because they are general:

- library and system content differs between environments;
- refusals and error paths involve no server at all;
- write operations are unsafe to exercise repeatedly;
- a public repository's CI has no credentials.

What *does* generalise is running the same **projection** twice. Four kinds carry the load:

| Projection | What it asserts | Used here |
|---|---|---|
| **capability** | the system offers what the declaration says it offers | 9 |
| **population** | the shapes present are the shapes expressed | 3 |
| **wire** | the emitted bytes match the captured bytes | 8 |
| **differential** | two sources that must agree, do | 4 |

**All 24 checks run offline, with no credentials and no network.** That is better than predicted:
the earlier analysis expected three of the four kinds to run offline and treated the differential
kind as needing a live system. Declaring the differential between *two committed sources* rather
than between a source and a live server kept the whole set credential-free.

### What the generator actually buys

This deserves honesty, because the generator is not where most of the value is. On the earlier
codebase, a hand-written alternative — **31 lines of plain pytest** reading the same committed
capture — caught the same defects. **The capture does the work.**

Generation costs roughly 157 lines beyond that, and buys four categorical properties that the
hand-written version cannot have:

1. **No slot for a hand-typed expected value.** The declaration has nowhere to write the answer
   you hope for, so a check cannot silently encode a wrong expectation.
2. **A requirement with no check goes red.** Coverage is enforced rather than reviewed.
3. **The capture and the checks cannot drift apart**, because both are generated from one
   declaration.
4. **A vacuity self-test comes free** (below).

Those four are worth roughly 157 lines at around twenty checks. They are not worth it at three.
Keep that threshold in mind — it is the whole argument of the next section.

---

## Why requirements-first changed the outcome

This is the actual finding.

The same technique was judged **not worth doing** on the existing tools and **clearly worth doing**
on the new package. The technique did not improve. The economics did.

- **Retrofitted onto a finished codebase**, the exercise surfaced about **three** checkable facts.
  Below the threshold. The correct call was plain pytest, and that was the call made.
- **Declared before the implementation existed**, the same exercise produced **24**. Above the
  threshold, comfortably.

The reason is not that the new package is larger — it is smaller. It is that **the order of work
determines what gets declared.**

When requirements are written after the code, you can only declare facts you can still find. The
checkable ones are whatever survived implementation in a legible form, and most of the decisions
that were worth pinning have already dissolved into the code. Three facts is what excavation
yields.

When requirements are written first, every decision is a declaration *before* it is code. The
error vocabulary, the exit-code mapping, the credential contract, the redaction shape, the encoder
digest — each was a declared member with a stated relation before anything implemented it. The
implementation was then written to satisfy the declaration rather than the declaration written to
describe the implementation.

That inversion is the whole result. **Requirements-first is not a tidier way to arrive at the same
place; it changes how many facts there are to check, by roughly an order of magnitude on this
sample.**

---

## The vacuity property

A check that has never failed is not yet a check. This is the part of the design most worth
copying.

The generated suite includes a self-test parametrised across every check:

```python
def test_no_check_is_vacuous(fact):
    """Every check above fails when the thing it names is broken.

    The mutations come from the relation, not from this file: each relation knows what
    a violation of itself looks like, so a new fact gets a vacuity proof without anyone
    writing one. A relation that produced no mutation would let a check through
    unproven, so that is a failure too.
    """
```

Two properties make this stronger than a hand-written negative test:

- **The mutations come from the relation, not from the test file.** There are four relations —
  `equal`, `covers`, `wire`, `differential` — and each knows what violating *itself* looks like.
  A newly declared fact therefore arrives with a vacuity proof already attached, written by nobody.
- **A relation that offers no mutation is itself a failure.** There is no way to declare a fact
  whose check is unfalsifiable, because "I cannot be broken" is treated as a defect rather than as
  a pass.

Results:

- The self-test executes **36 mutations across the 24 checks**, and **36 of 36 force a failure**.
- Separately, **10 deliberate breaks were introduced into the source**. All 10 were caught, and —
  the part that matters — each was caught by **exactly the expected set of checks: zero extra,
  zero missing, verified by set equality rather than by eye.**

That last measurement is the one that distinguishes a real suite from a suite that merely goes red
when something is wrong. A check that fires on everything is nearly as useless as one that fires on
nothing; set equality is what proves each check is testing the thing it names.

---

## Where MetaObjects was deliberately *not* used

A case study that only reports the win is not much use, so here is the boundary.

The package's TOON row shapes — tuples naming the columns of tabular output — were left as plain
Python. The measurement for that was independent and still stands: modelling them cost **155 lines
of YAML to replace 50 lines of Python**, a net **+133 lines**, plus a build step, a raised Python
floor, and either a heavy runtime dependency or 161 lines of template artefacts emitting 21 lines.

That verdict is arithmetic, not expressiveness, so it is untouched by the modelling correction
described earlier. It is also worth noting that an independent review of the question found the
row shapes were not part of the package at all — they are the command line's `--fields` flag
vocabulary, living in the tools' command modules. The question was partly moot before the
arithmetic was even reached.

The general rule this suggests: **model the facts a requirement needs to tag. Do not model
structures whose only consumer is one module's rendering path.**

---

## What this does and does not show

**Shows**, on this sample:

- The expressiveness objection to modelling requirements was a modelling error, and is removable.
- Declaring requirements before implementing produced roughly 8× the checkable facts that
  retrofitting produced, which moved generation from below its cost threshold to above it.
- Every generated check can be made to run offline with no credentials, including the differential
  kind, by declaring the differential between two committed sources.
- Vacuity can be proven mechanically rather than asserted, and proven *specifically* — each break
  caught by exactly the right checks.

**Does not show:**

- Anything about long-term maintenance. This is one package at one point in time; there is no data
  yet on what happens to a declaration under a year of change.
- That the result generalises beyond one package by one author. `n = 1`.
- That the toolkit tier benefits equally — at the time of writing, the requirements layer is
  complete and the rest of the package is still being built against it.
- That modelling is right for structural data generally. The row-shape measurement above is a
  counter-example inside the very same package.

The honest one-line version: **the technique did not get better; starting from the requirements
made there be enough facts for the technique to pay for itself.**
