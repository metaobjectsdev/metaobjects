# ADR-0059: References resolve once, after the tree

## Status

**Accepted** (2026-10-17), for 1.1.0. Rides the `metamodelVersion` `1.1` bump already in this
release: the canonical grammar change in Decision 9 is a metadata-contract change
(`docs/compatibility-policy.md` places the `extends` / `@via` grammar and the package `::`
syntax under the metamodel version).

- **Supersedes [ADR-0032](ADR-0032-canonical-fqn-refs.md) §3** (canonical JSON is FQN-only by
  input contract, enforced by a guard) **and §4** (the YAML desugar expands references; the JSON
  loader does a pure FQN match). ADR-0032 §2's reference grammar (`::Name` root-absolute,
  `..::Name` parent-relative, `pkg::Name` exact, bare `Name`) stands, and now applies to every
  source.
- **Amends [ADR-0042](ADR-0042-bare-references-are-package-local.md).** §2 (a bare name is package-local,
  then root-level) stands. §3's sentence that the desugar folds bare names is replaced by
  Decision 1 below, and §4's `extends` claim is corrected by Decision 3: a bare `extends`
  resolves in its own file's package, then at the root, and never binds an object in another
  package.

## Context

Before this decision a reference was interpreted in two places. The YAML desugar rewrote
reference values while it lowered YAML to the canonical shape (bare names to the file's package,
`::` and `..::` expanded against the node being lowered). Canonical JSON took values as written
and resolved them later, in each port's loader, and refused `::` and `..::` outright
(`ERR_RELATIVE_REF_IN_CANONICAL`). The two paths disagreed:

- YAML `::Apple` from package `acme` bound `acme::Apple` when both a root `Apple` and an
  `acme::Apple` existed, because the expanded string was then re-resolved package-locally.
- An inherited bare reference resolved in the inheritor's package from JSON and in the
  declarer's package from YAML.
- A bare `@of` after `@via` resolved in the package the walk reaches from JSON only.
- A file with no `package` inherited the package of whichever file it merged into, so the same
  model loaded differently depending on file order.
- The serializer wrote values as they were stored, so a multi-package model exported to JSON did
  not always load back to itself.

A load of each conformance fixture as JSON and as YAML (the "twin" comparison) found differences
in 17 fixtures in TypeScript, Python and C#, and 13 in Java. Every port also carried several
private re-implementations of reference matching, some of them by short name.

## Decision

**1. Sources do not interpret references.** YAML, canonical JSON and any later source produce the
canonical-shaped tree with every reference string exactly as written. The YAML desugar keeps all
of its syntactic work (fused keys, scalar bodies, `[]`, sigil-free attributes, the coercion
guard) and stops rewriting reference values.

**2. One resolver per port.** A reference splits into an owner and a dotted child tail (the tail
starts at the first `.` after the owner's last `::`). The owner resolves by its form:

- `::Rest` — root-absolute: the node whose resolution key is exactly `Rest`. No package-local
  retry.
- `..::Rest` — parent-relative: drop one trailing segment of the referrer's package per `..::`,
  then look up `<remaining>::Rest` (or `Rest` when nothing remains) exactly. More `..::` than
  segments is `ERR_BAD_ATTR_VALUE`.
- `pkg::Name` — exact.
- bare `Name` — exact `<referrerPkg>::Name`, else exact root-level `Name` (ADR-0042 §2).

The tail then walks child names (ADR-0029). No resolver matches by short name or by bare tail.

**3. The referrer package.** The package a reference resolves in is:

- by default, the effective package (`package`, else the file's package, else root) of the
  top-level node that **physically declares the attribute**, so an inherited reference means what
  it meant where it was written;
- for `@of` on a dimension that also has `@via`, the package of the entity the `@via` reaches;
- for `@spine` on a report, the package of the report's `@from` entity;
- for `extends`, the declaring node's own file package.

**4. One set of reference attributes, the same in every port:** `extends`, `@objectRef`,
`@through`, `@references`, `@from`, `@via`, `@of`, `@parameterRef`, `@payloadRef`,
`@responseRef` and `@spine`. `@implementedBy` is not in the set: its grammar names members as
well as objects, and the requirement gate resolves it separately.

**5. Resolve once, before freeze.** After the last validation pass and before the tree is frozen,
a `resolveReferences` pass walks the physical tree. For every own reference attribute that
resolves it stores the target on the attribute node (`resolvedTarget`), keeps the authored
string (`authoredValue`) and rewrites the value to its canonical spelling. `extends` keeps its
super pointer and stores the canonical spelling plus the authored one. A reference that does not
resolve is left as written; validation has already reported it with its own code, so error codes,
order and positions do not change.

**6. Canonical spelling.** A packaged target is written `pkg::Name`. A root-level target is
written `::Name` from a packaged referrer and `Name` from a root-level one. The dotted tail is
kept. A canonical value is absolute: `pkg::Name` and `::Name` name exactly one node, and a bare
canonical `Name` means the root-level object. It keeps that meaning wherever it is read, so a
root-level declarer's bare `Name` inherited by a node in package `acme` still names the root
`Name` when `acme::Name` exists.

**7. Consumers read the resolved model.** Every consumer after load reads the bound target
(`refTarget(node, attr)` in TypeScript) or resolves the canonical value exactly
(`lookupCanonical`). It never resolves a canonical value again with a referrer package, because
the package of the node that inherits an attribute is not the package it was written in, and
applying it would turn a bare root-level `Name` into `<inheritor's package>::Name`. A
validation pass, which runs before `resolveReferences` and reads authored values, resolves in
the package of the node that physically declares the attribute (Decision 3). Code that
compared a reference value to an object's short name compares the target node instead, and
no consumer binds by short name.

**8. The serializer writes canonical values.** `canonicalSerialize` writes the canonical
attribute values and the canonical `extends`. Document package rule:

- every named top-level node has the same non-empty effective package `P`: write
  `metadata.root.package: P`, and keep any package a node states itself (so single-package
  documents do not move). When the root states no package and every node names `P` itself, the
  root package stays absent;
- otherwise: no root package, and each named top-level node carries its own effective package.

A `refs: "authored"` option writes the authored spellings instead. Only `meta fmt` uses it, so
`fmt` stays a layout and order formatter and does not rewrite an adopter's references. Its
equivalence check (that a formatted file loads to the same model) compares canonical output,
because it is checking meaning.

**9. Canonical JSON accepts every form.** The relative-reference guard is deleted and
`ERR_RELATIVE_REF_IN_CANONICAL` is retired. The serializer never writes `..::`.

**10. The default package is per file.** A file without `package` declares root-level nodes
whatever order the files load in.

**Human-facing text keeps quoting what it quoted.** Documentation pages, describe text and
refusal messages that printed a reference as the author wrote it keep doing so (`authoredAttr` in
TypeScript reads the authored spelling through `extends`), so a reader can find the line they
wrote and existing documentation does not churn. Text that printed the value the YAML desugar had
expanded (the docs site's origins table) now prints the canonical value, which is the same
string. Generated code that names a type uses the
target's own name, never the reference string (a reference is no identifier). The neutral
template data (`targetRef`) carries the canonical value, so it does not depend on how a reference
was spelled.

## Two gates, in every port

- **YAML twin.** Every conformance fixture's input loads once as JSON and once with the same texts
  read as YAML, in the same order. Both loads report the same ordered error codes and, when clean,
  serialize identically (effective serialization too, where the fixture has one). Exclusions live
  in `fixtures/conformance/yaml-twin-exclusions.json`, one reason per entry.
- **Round trip.** Every fixture's `expected.json` loads as the only input and serializes back to
  itself. Exclusions live in `fixtures/conformance/round-trip-exclusions.json`.

## Consequences

- A reference means the same thing whatever source it was written in, and exported JSON loads
  back to the same model.
- Canonical output changes: references are fully qualified, a root-level target from a package is
  `::Name`, and a multi-package document carries a package on each top-level node. The shared
  goldens moved once, from the TypeScript oracle.
- A bare `extends` that named an object in another package now fails with
  `ERR_UNRESOLVED_SUPER` in every port, as ADR-0042 already required and Java already did.
- Generated output that printed a reference string may now print the canonical form. The
  CHANGELOG lists the diffs to expect.
