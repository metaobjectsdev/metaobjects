# ADR-0057: Requirement checks and requirement tests run in every port

## Status

**Accepted** (2026-10-05). Reverses the "Checks — TypeScript only, by decision" boundary stated
in `docs/CONFORMANCE.md` ("Split coverage"), a decision that never had an ADR of its own.
Registers no vocabulary: `metamodelVersion` stays `1.1` and
`fixtures/registry-conformance/expected-registry.json` is untouched.
[ADR-0015](ADR-0015-single-shared-migrate-engine.md) is unchanged.

Contract tables, per-port work and the corpus case lists:
[`docs/superpowers/plans/2026-10-05-requirements-slice-1-checks-and-test-generators.md`](../../docs/superpowers/plans/2026-10-05-requirements-slice-1-checks-and-test-generators.md).

## Context

A requirement (`requirement.functional`, `requirement.architectural`) is metadata, and all five
ports load and validate it. Two things were built on top of that vocabulary, and both shipped in
TypeScript only:

- **The requirement gate.** `meta verify` checks that every claim resolves, that links sit at or
  below the link floor, that nesting agrees with levels, that a live policy is applied to
  something, and it reports the ledger on every run.
- **The test scaffold.** `requirementTests()` emits one test stub per claim, which the project
  fills in by hand and the three-way merge preserves.

The split was a decision, and the only place it was recorded as one is `docs/CONFORMANCE.md`,
"Split coverage" (`docs/features/requirements.md` and the pillar summaries stated the split
without the reasoning):

> *Checks — TypeScript only, by decision.* The `meta verify` diagnostics over requirements ship
> in the TypeScript CLI; the other ports load and validate and stop there. Same call as ADR-0015:
> one implementation of a build-time gate rather than five, where the gate is not a per-port
> runtime concern.

The reasoning was the one ADR-0015 applied to schema migrations. The gate reads canonical
metadata, which is identical in every port, and prints diagnostics. A function with identical
input and identical output wants one implementation, not five kept in agreement by a test suite.

That reasoning does not carry over, for three reasons.

1. **A requirement test is code in the project's own language.** ADR-0015 holds because a
   migration's output is SQL, the same artifact whichever port the application is written in. A
   test is not: a pytest project needs a pytest file, a JUnit project a JUnit class, an xUnit
   project an xUnit class. One implementation of the scaffold serves one port by construction.
2. **The scaffold needs the gate's machinery anyway.** Generating a test from a requirement
   takes the same walk, the same address and the same claim resolver the gate uses. A port that
   scaffolds tests therefore already holds everything the gate is built from, and a port that
   generated tests from claims its own `verify` never checked would be scaffolding from a ledger
   it had not validated.
3. **Each port already runs a `verify` in the project's own build**, and already runs a shared
   check there: the field authoring lint, held across the ports by
   `fixtures/field-lint-conformance/`. The cost the original decision avoided, five
   implementations drifting, has a remedy this repository already uses.

## Decision

The owner has ruled that **every language runs the requirement checks and scaffolds tests from
requirements.** The clauses below are that ruling and the rulings that follow from it. None of
them is open.

### The gate

1. **Every port's `verify` runs the requirement gate**, on every run and with no subverb:
   `meta verify` (TypeScript), `metaobjects verify` (Python), `mvn metaobjects:verify` (Java and
   Kotlin, which share the Maven goal) and `dotnet meta verify` (C#). The gate is implemented
   per port, in the port's core library.
2. **The gate is held to the TypeScript reference by a shared corpus**,
   `fixtures/requirement-check-conformance/`. Its expectations are produced from the TypeScript
   implementation and committed. A port that disagrees with a committed expectation is wrong
   unless the reference is shown to be wrong first.
3. **Diagnostic message text is pinned by that corpus**, with the code, the severity, the path
   and the summary counts. The field-lint corpus already works this way.
4. **The strict switch keeps the code and raises the severity.** A live functional requirement
   that nothing implements is `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` at severity `warn`. Under
   `--require-implementers` (or `META_REQUIRE_IMPLEMENTERS=1`;
   `-Dmeta.verify.requireImplementers=true` on the Maven goal) the same code is reported at
   severity `error`. There is no new `ERR_` code.
   The flag is not called `--strict`, because `verify` already has `--lax` on a different axis
   (ADR-0023 attribute strictness) and a `--strict` beside it would read as that flag's opposite.
5. **A model with no `requirement.*` node sees no change in any port**: no line printed, no
   exit-code change, no file generated.

### The generator

6. **Every port ships a `requirement-tests` generator**: the existing TypeScript one, pytest for
   Python, JUnit Jupiter for Java and for Kotlin, xUnit for C#. It is implemented per port.
7. **The generator is held by a second shared corpus**,
   `fixtures/requirement-test-identity-conformance/`. It pins the *identity* of every generated
   test (its package, path, unit, id, witness key, status, skip state and digest), which is the
   same in five ports. It does not pin emitted bytes, which are each port's own language.
8. **Generated Java and Kotlin tests are JUnit Jupiter only.** A JUnit 4 project uses the
   renderer hook or ejects the generator.
9. **The digest covers six things**: subtype, level, status, statement, counterexample and the
   `implementedBy` list. It does not cover the title, description, notes, disposition,
   `trackedBy`, `supersededBy`, the name, the package or nested requirements. It answers "did the
   claim change", not "did the entry move". It is written into the generated file, which is what
   turns `verify --codegen` red when a claim changes.
10. **The filter that selects which requirements get a test is uniform.** Every port offers the
    same two options: a predicate over one shared *requirement view* (subtype, level, status,
    path, effective package and the distinct concerns of the resolved targets), and a switch for
    the warning that names what the filter excluded. With no predicate, the default is
    functional requirements at level 4 and 5.
11. **Generated tests import nothing from MetaObjects.** Python output imports `importlib` and
    `pytest`; JVM output imports JUnit; C# output imports xUnit.

### The witness model

12. **Outside TypeScript the generated test file is fully machine-owned** and rewritten whole on
    every run. No three-way merge is ported. Project code lives in a *witness*: a function the
    project owns, which the generated test calls. A requirement that is live or partial and has
    no witness is a failing test that names the function to write.
13. **A JVM or .NET generated test finds its witness through a generated interface**, with one
    member per test that is not skipped and a failing default for each. The project names one
    class that implements it. There is no run-time lookup by name (ADR-0001). A requirement that
    becomes live adds a failing default, which is a red test and not a compile break. A
    requirement that is retired or deleted removes its member, so a stale override stops
    compiling.
14. **A Python generated test looks its witness up by name** in a configured module. Python has
    no static binding to offer, and this is test code, so it is the one by-name lookup in the
    design.
15. **TypeScript keeps its own model**: hand-filled stubs, preserved by the three-way merge. The
    witness model is not offered there.
16. **The Python interpreter floor is documented, not lowered.** The tool needs Python 3.11 or
    later to run. The tests it generates parse under the 3.9 grammar and need only pytest, so a
    project on an older interpreter runs the tool with a different one.

### What is a contract and what is a recommendation

17. **The generator, its renderer and the witness model are a recommended approach, not a
    contract.** The generator is a reference helper (ADR-0034 Amendment 3). It is ejectable in
    every port through that port's existing eject mechanism (`meta eject`, `metaobjects eject`,
    `mvn metaobjects:eject`, `dotnet meta eject`), and an application may change or replace its
    copy freely.
18. **The checks in `verify` stay stock.** They are not ejectable in any port, because they are
    the shared contract.
19. **`verify` still never reads test results.** The generator emits the tests, the codegen
    drift gate proves the set matches the ledger, an unfilled live test fails, and the project's
    own test run supplies "passing".

## Consequences

- **A change to a gate code, a message, the test identity or the digest is now a five-port
  change with a corpus edit.** Rewording one diagnostic touches five implementations and the
  committed expectations. That cost is the price of clause 3 and is accepted.
- **The analogy with ADR-0015 no longer applies to requirements.** ADR-0015 itself is
  unchanged: schema migrations stay owned by the TypeScript toolchain, for the reason that ADR
  gives.
- **The seven authoring-lint advisories stay TypeScript-only in this slice**, by the owner's
  ruling. They never fail a build. Porting them is a follow-up slice. Until then the split is
  narrower, not gone: the gate is in every port, its advisory lint is in one.
- **A project that declares requirements on a non-TypeScript port will see diagnostics it did
  not see before, and its `verify` may now fail.** That is the purpose of the change, and the
  `CHANGELOG.md` entry for the release says so.
- **JVM and .NET projects pay one setup cost.** The generated test module does not compile
  until the project creates its witness class.
- **A passing generated test proves that the witness ran**, not that the witness tests the
  claim. The boundary `docs/features/requirements.md` draws under "What a green run does not
  prove" still holds.
- **TypeScript and the other four ports differ in how a project supplies its test body.**
  TypeScript's emitted bytes do not change; its test names do not carry the package, and the
  other ports' identities do.

## Realization status

At acceptance, TypeScript has the gate, the generator and (with this ADR) the strict switch. The
two corpora and the Python, Java, C# and Kotlin implementations land in the order the plan
gives. `docs/CONFORMANCE.md`, `docs/features/requirements.md` and the pillar summaries still
state the TypeScript-only split until the ports that make it false have landed; they are
corrected with them, not ahead of them.

## Alternatives considered

- **Keep the checks TypeScript-only and have other ports run the Node CLI for them.** Rejected:
  the scaffold cannot be single-port (Context, reason 1), and once a port has the scaffold's walk
  and resolver the gate is a thin layer over them.
- **A new `ERR_REQUIREMENT_NOTHING_IMPLEMENTS` code for the strict switch.** Rejected: one
  finding under two codes splits every suppression, report and corpus case keyed on the code.
  Object coverage already works the other way, with one code and a named severity constant.
- **A run-time lookup by name for JVM and .NET witnesses, as Python does.** Rejected: it is
  runtime reflection (ADR-0001), and a witness for a deleted requirement would go on existing
  unnoticed. The interface makes that a compile error.
- **Port the three-way merge to four more languages.** Rejected: none of those ports has one,
  and the witness model keeps hand-written code out of the generated file altogether.
- **Emit JUnit 4 as well as Jupiter.** Rejected: the renderer hook and eject already cover a
  JUnit 4 project, and a second stock output is a second thing to test and document in two ports.
- **A digest over every attribute.** Rejected: an edit to a title, a note or a disposition would
  turn every generated file stale without the claim having changed.
- **Pin codes in the corpus and leave message text to each port.** Rejected: the message is what
  an adopter reads, and unpinned prose is where the ports would drift first.
- **Lower the Python floor to 3.9.** Rejected: the generated output already runs there, and the
  tool can be run with a different interpreter than the project's own.
- **Per-port filter options**, with the predicate offered in TypeScript and Python only.
  Rejected by the owner: the filter is uniform.
- **Make the generator's output a cross-port contract.** Rejected: it writes code into the
  adopter's repository, which makes it a helper the adopter owns. The identities are pinned so
  the ports agree on *what* is tested; how the test is written is the application's to change.
