# `verify` requirement-gate conformance corpus

Every port's `verify` runs the **requirement gate**: it reads the `requirement.*` nodes of a
loaded model and reports what the loader cannot (ADR-0057). This corpus is the shared source
of truth for the gate's codes, severities, node addresses, message text and summary counts.

TypeScript is the reference. The codes, their conditions and their order come from
`server/typescript/packages/cli/src/lib/requirement-check.ts`; a port reads that file before
it writes its own checks, and its test suite runs this corpus so the ports cannot drift.

## Fixture format

Each case is a directory:

- `input/` holds one or more metadata documents (`.yaml` or `.json`).
- `options.json` is optional. Its keys are `libraries` (a string array: the shipped
  libraries to load beside `input/`) and `requireImplementers` (a boolean: the strict
  switch, `verify --require-implementers`). No other key is legal.
- `expected.json` holds `{ "diagnostics": [...], "summary": {...} | null }`.

A runner does three things, in this order:

1. Load `input/` with the port's loader, **strict**, with the libraries `options.json`
   names, and assert **no load errors**. Load the files in ascending file-name order.
2. Run the gate over the loaded model, with the strict switch `options.json` sets
   (default off), and compute the summary from the same run. Pass **no scope predicate**:
   every non-abstract entity in the loaded model is coverable. Do **not force the coverage
   answer**: whether coverage is measured is derived from the requirements' packages, which
   is what the `coverage-library-*` cases test. (In the reference these are the
   `coverable` and `measureCoverage` options of `scanRequirements`; a runner sets neither.)
3. Compare both with `expected.json`.

### What is compared

`diagnostics` is an unordered multiset of `(severity, code, path, message)`. The files list
them in the order the reference reports them, which is not part of the contract.

- `severity` is `error` or `warn`.
- `path` is the dotted chain of requirement names from the root, with no package:
  `Shop.Orders.Recorded`. It is **absent** on `WARN_REQUIREMENT_OBJECT_UNCLAIMED`, whose
  subject is an entity; compare an absent `path` as the empty string.
- `message` is compared exactly.

`summary` is `null` when the model declares no requirement. Otherwise it holds `total`,
`functional`, `architectural`, `byStatus` (a count per status that occurs; a status with no
requirement has no key), `undecided` and `deferredUntracked`. `entitiesClaimed` and
`entitiesTotal` are present **only when coverage is measured**: their absence is the
statement that the project authored no requirement of its own.

### Where the expectations come from

`bun scripts/write-requirement-corpus-expected.ts check` writes every `expected.json` from
the TypeScript reference. Each written file is then reviewed by hand against the reference's
rules, and a case that reports more than its row below says gets its **input** fixed.

A committed `expected.json` is never edited to make a port pass. A port that disagrees with
it is wrong, unless the reference is shown to be wrong first.

## Things the cases pin that are easy to miss

- **A rejected claim still counts toward coverage.** The claim set is built from every
  requirement that is not `planned`, whatever its level and whatever the gate says about
  the reference's grain. `link-above-floor`, `l4-names-member`, `l5-names-object` and
  `arch-levelled-tree` each report an error on a claim and no unclaimed entity.
- **`ERR_REQUIREMENT_LINK_ABOVE_FLOOR` ends that requirement's checks.** Nothing else is
  reported for the node (`link-above-floor`).
- **A grain error replaces the dangling check for that reference.** `l4-names-member` and
  `l5-names-object` each hold a reference that does not resolve and report it once.
- **Existence is about naming, not resolving.** A requirement whose subtree holds any
  non-empty `implementedBy` is not reported by `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`, even
  when the only one is on a `planned` child and names a node that does not exist yet
  (`nothing-implements-delegating-parent-clean`).
- **`supersededBy` resolves against the ledger, not the model, and a bare path that is
  ambiguous across packages still binds.** The name of an object does not resolve
  (`superseded-by-dangling`). A bare path is looked up across every package, and when two
  packages both have it the reference takes the first in walk order instead of refusing
  (`superseded-by-package-local`). This deliberately differs from `implementedBy`, where a
  bare name that exists in two other packages binds nothing
  (`dangling-bare-name-in-two-packages`). The case pins that the reference resolves; which
  of the two requirements it binds is not observable in a diagnostic.
- **One message names two objects, in a fixed order.** The hint in
  `dangling-bare-name-in-two-packages` reads `acme::billing::Order, acme::shop::Order`.
  The fixture loads the billing file first and the two names also sort that way, so it
  pins the order of this one message and not the rule behind it. The reference lists the
  objects in load order, which is why step 1 fixes the file order.
- **The library cases count the library's own ledger.** The three `coverage-library-*`
  summaries include the requirements the `iam` library ships, so a change to that ledger
  changes those three files. Every port embeds the same library, so the ports still agree.

## Cases

| Case | What it pins |
|---|---|
| `no-requirements` | Entities and no requirement: no diagnostics, and `summary` is `null`. |
| `clean-fully-claimed` | An L1 to L5 tree that claims every entity: no diagnostics, and the full summary with both coverage counts. |
| `dangling-object-live` | `ERR_REQUIREMENT_DANGLING_REF` on a `live` requirement naming an object that does not exist. No object has that short name, so there is no hint. |
| `dangling-object-partial` | The same on `partial`. The message carries the status. |
| `dangling-object-planned-clean` | The same reference on `planned` reports nothing: a planned requirement may name nodes that do not exist yet. |
| `dangling-object-did-you-mean` | The hint when the short name exists in one other package, for a bare object reference and for a member reference whose owner does not resolve. The second message quotes the whole reference (`Invoice.total`) while its hint names the object (`Invoice`), not the member. |
| `dangling-bare-name-in-two-packages` | A bare name that exists in two other packages binds neither. The hint lists both, `acme::billing::Order` first. |
| `dangling-member-of-resolved-object` | The object resolves and its member does not: the hint names the object's resolution key and the missing member. |
| `dangling-member-first-missing-segment` | Two-segment member paths. The hint names the first segment that did not resolve and the node it was looked for under: once when the first segment resolves, once when it does not. |
| `claim-on-root-template` | A root-level `template.prompt` is a claim target, by bare name and by qualified name. Coverage is measured over zero entities, so both counts are `0`. |
| `claim-package-local` | A bare reference binds in the requirement's own package across two files, while an object of the same name exists in another package and is claimed there the same way. |
| `link-above-floor` | `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` at L1 and at L3. The `disposition` on the live L1 produces no `WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE`. |
| `l4-names-member` | `ERR_REQUIREMENT_L4_NOT_OBJECT` on a functional L4, for a member that exists and for one that does not. |
| `l5-names-object` | `ERR_REQUIREMENT_L5_NOT_MEMBER` on a functional L5, for an object that exists and for one that does not. |
| `l5-member-resolves-clean` | A functional L5 naming a field, an identity, and a view under a field: no diagnostics. |
| `bad-level-out-of-range` | `ERR_REQUIREMENT_BAD_LEVEL` for levels 0 and 6 on functional requirements. The message has no architectural suffix. |
| `level-nesting` | `ERR_REQUIREMENT_LEVEL_NESTING` for a child at its parent's level and for a child above it. |
| `arch-live-no-implementers` | `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` on a flat policy that is `live`, on one that is `partial`, and on a levelled L4 that is `live`: the rule is "may name the model and names nothing", not "has no level". |
| `arch-planned-clean` | A `planned` flat policy with no implementer reports nothing. |
| `arch-retired-clean` | A `retired` flat policy with no implementer reports nothing. |
| `arch-levelled-tree` | Levelled architectural requirements: an L1 with links gets `ERR_REQUIREMENT_LINK_ABOVE_FLOOR`; an L1 and an L2 without links get no `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS`; a child that re-ascends gets `ERR_REQUIREMENT_LEVEL_NESTING`; a level of 7 gets `ERR_REQUIREMENT_BAD_LEVEL` with the architectural suffix. |
| `arch-unlevelled-exempt` | A flat policy at the root, and one nested under a levelled parent, get neither the level error nor the nesting error. |
| `arch-mixed-grain-clean` | An architectural L4 may name a member and an architectural L5 may name an object: no diagnostics. |
| `disposition-not-applicable` | `WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE` on `live` and on `retired`. The message carries the disposition and the status. |
| `deferred-untracked` | `WARN_REQUIREMENT_DEFERRED_UNTRACKED` on a deferral with no `trackedBy`, and nothing on the tracked deferral beside it. `deferredUntracked` is `1`. |
| `nothing-implements-subtree` | `WARN_REQUIREMENT_NOTHING_IMPLEMENTS`, severity `warn`, on every node of a subtree in which nothing names a node: a `live` L1, a `partial` L3 and a `live` L4. |
| `nothing-implements-delegating-parent-clean` | A parent whose child claims is not reported. Neither is one whose only claiming child is `planned`. |
| `require-implementers` | The input of `nothing-implements-subtree`, byte for byte (the reference runner asserts it), with `requireImplementers: true`: the same code, path and message, at severity `error`. |
| `require-implementers-raises-only-that-code` | `requireImplementers: true` over a model that also has an untracked deferral and an unclaimed entity: `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` is an `error`, while `WARN_REQUIREMENT_DEFERRED_UNTRACKED` and `WARN_REQUIREMENT_OBJECT_UNCLAIMED` stay `warn`. |
| `superseded-by-resolves-clean` | A `supersededBy` given as the requirement's path, and as the path qualified by its package: no diagnostics. |
| `superseded-by-dangling` | `ERR_REQUIREMENT_DANGLING_REF` for a `supersededBy` that is a misspelt path, a requirement's name without its path, and the name of an object. |
| `superseded-by-package-local` | The ledger lookup over four packages, all resolving: a bare path that two packages both have, referenced from each of them and from a third package that has no such path (ambiguous across packages, and it still binds); and a reference completed with the referrer's package. |
| `retired-clean` | A retired requirement, and a retired tree with nothing claimed beneath it, report nothing. |
| `same-name-in-two-branches` | Two requirements named `Recorded` report the same error with the same message. Only `path` tells them apart. |
| `coverage-unclaimed-entity` | `WARN_REQUIREMENT_OBJECT_UNCLAIMED` for the one entity no requirement claims. It has no `path`. |
| `coverage-planned-claim-does-not-count` | An entity claimed only by a `planned` requirement is still unclaimed. |
| `coverage-arch-claim-propagates` | An architectural claim on an abstract base covers a subtype and a subtype of that subtype: no diagnostics, two of two entities claimed. The first `extends` is a bare name; the second is in another package and is a qualified name, so matching either string form alone does not reach both. |
| `coverage-functional-claim-does-not-propagate` | The same model with a functional claim leaves both subtypes unclaimed. |
| `coverage-exemptions` | An abstract entity, an `object.value` and an `object.projection` are not counted: one of one entities claimed. |
| `coverage-library-only-not-measured` | `libraries: ["iam"]` and no project requirement: no unclaimed-entity warning, and no `entities*` keys in the summary. |
| `coverage-library-plus-project` | One project requirement switches coverage on, over the library's entities too. The library's ledger claims its own, so only the project's unclaimed entity is reported. |
| `coverage-library-overlay-does-not-activate` | An overlay on a library requirement changes that requirement's status and does not switch coverage on. |
| `summary-undecided-rollup` | `undecided` is `4` over four trees and one root node: a partial parent over a partial child counts once, at the child; a partial grandchild excludes both ancestors; a child with a `disposition` is not counted and still excludes its parent; a partial parent over a `live` child counts at the parent; and `DeliveryNote` beside `Delivery` counts without excluding it, because ancestry is by path segment and not by string prefix. |

## Who asserts it

| Port | Runner |
|---|---|
| TypeScript (reference) | `server/typescript/packages/cli/test/requirement-check-conformance.test.ts` |
| Python | `server/python/tests/conformance/test_requirement_check_conformance.py` |
| Java | `server/java/metadata/src/test/java/com/metaobjects/conformance/RequirementCheckConformanceTest.java` |
| Kotlin | inherits via Java: Kotlin has no CLI of its own and runs `verify` through the same Maven `metaobjects:verify` goal |
