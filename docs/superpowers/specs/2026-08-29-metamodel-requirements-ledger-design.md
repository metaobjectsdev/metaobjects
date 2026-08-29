# MetaObjects as its own requirements ledger

**Status:** design approved in chat 2026-08-29. Phase 1 specified; Phases 2-5 shaped only.

**Supersedes** the first draft of this file, whose subject was the metamodel vocabulary alone.
The scope widened in review: the ledger describes the **whole solution**, functional and
non-functional, and the vocabulary becomes one branch inside it.

## Why

Five ports hand-write their provider registrations - 69 `type.subType` entries carrying
422 attributes, five times over - and `fixtures/registry-conformance/expected-registry.json`
exists to reconcile them after the fact.

That gate byte-matches **vocabulary**. It is blind to **behaviour**, and the blindness is
measured, not theoretical. On 2026-08-29 a single attribute, `@column`, was found to mean
three different things across the ports: Python's read model used it as the *Pydantic field
name*, Kotlin's Exposed generator *ignored it entirely* while hardcoding snake_case, and
Java's runtime resolved it literal - one model, two column names, one JVM. Every port
byte-matched the manifest throughout. Earlier instances of the same class: `like`
case-sensitivity (four releases), int-backed `field.enum` codecs (two ports composing,
four silently wrong), `{{#hasField}}` (all five ports, no fixture existed).

The manifest proves the ports *spell* the vocabulary identically. Nothing states what the
vocabulary must **do**, so nothing can be gated on it.

## What this is for

**Dogfooding, on the hardest case.** The requirement feature ships in all five ports and
this repository does not use it. The project has no `metaobjects/` directory and declares
no `object.entity` at all, so the ledger will be authored against a subject with no domain
model - the least forgiving possible test of a feature designed for domain models.

That purpose orders every trade-off below. Where a choice lies between *covering more* and
*exercising the feature harder*, exercising wins. Where it lies between *a bespoke
convenience* and *stock vocabulary under strict load*, stock wins.

The enforcement gate, the coverage check and the generated harness all remain valuable, but
they are consequences. If they ship as warnings forever, the program still succeeded.

## Program

Five phases. Each is independently valuable; each gets its own plan.

- **Phase 1 - the capability map** (this document). The L1-L3 organisational tiers for the
  whole solution: a pillar-anchored functional capability map, and an ISO/IEC 25010 quality
  tree for the non-functional set. Roughly 65 nodes, all prose, no L4/L5, no codegen, no
  bespoke tooling. Loads under the stock strict registry today.
- **Phase 2 - the vocabulary branch.** L4 per concrete subtype, plus L5 for
  promise-bearing attributes only. The requirement-to-metamodel link is **derived** from the
  node's dotted path, and a repo-local `verify` checks each requirement is implemented in
  `spec/metamodel/*.json`.
- **Phase 3 - forward scaffolding.** A new requirement scaffolds a new `spec/metamodel`
  entry, which is then hand-edited: the MetaObjects pattern applied one level up, with the
  "generated artifact" being the metamodel JSON instead of code.
- **Phase 4 - generate what is hand-coded.** The ports' provider-registration code becomes
  generated output. `scripts/generate-embedded-metamodel.ts` already does this for
  TypeScript; the other four ports follow.
- **Phase 5 - the harness.** Per-port test scaffolds generated from the ledger.

Phase 1 stands alone. Nothing below it is committed by shipping it.

## Phase 1 design

### The ledger is stock metadata

No new vocabulary, no custom attributes, and **strict enforcement stays on**.

This was contested in design and the resolution matters. Carrying the metamodel's structural
facts (`dataType`, `min`, `max`, `default`, `allowedValues`) on requirement nodes would need
either custom attributes or `strict: false`. Both were rejected:

- **`strict: false` is out of bounds here.** ADR-0023 s1 scopes it to downstream apps and
  closes with *"The strict+sealed contract applies to the library's conformance, not to
  adopters."* This repository is the library. Dogfooding a feature with its principal
  guarantee disabled demonstrates less than dogfooding it intact.
- **Custom attributes on `requirement.*` would reverse FR-038.** That release made the
  requirement vocabulary prescriptive-only. A node saying *"money never touches a float"* is
  a requirement; a node saying `dataType: long, min: 0, max: 1` is a type definition.

The resolution removes the need entirely: structural facts stay in `spec/metamodel/*.json`,
requirements state promises, and Phase 2 links the two by **derivation** rather than
declaration. So the ledger uses only `requirement.functional`, `requirement.architectural`,
their eight registered attributes, and the common doc attrs.

For the record, three mechanical blockers were found and are the reason the above is not
merely a preference. `attr.properties` is chartered as the ADR-0023 escape hatch but
`@properties` is registered on **zero types**, so it is unreachable from a requirement node.
`requirement.*` accepts only `requirement.*` children, so the metamodel's 14 child-rules have
nowhere to live. And with L1-L3 spent on the solution map, L4 and L5 are the entire remaining
budget.

### `@implementedBy` is omitted throughout

It is optional (`min=0`) and legal only at L4/L5. Its referent is a **model node**, and this
repository has none. Omitting it is legal and dangle-free.

This is not a workaround. It is the same ruling that retired `@verifiedBy` in 0.24.0: a link
the author types is a link the author can get wrong, and the replacement is derivation. Phase
2's `verify` derives `type.subType[.attr]` from the requirement's dotted path, so the
generator owns the name and has nothing to guess.

The port-coverage attribute considered in review (`@ports`, marking which language ports
implement a requirement) is unnecessary for the same reason: per-port registry data already
answers it, so it is derived and cannot drift.

### Location and format

One file, `metaobjects/meta.requirements.yaml` at the repository root, package `metaobjects`.

YAML, not canonical JSON: hand-authored prose statements are the case ADR-0006's sigil-free
authoring front-end exists for.

A single file is right for Phase 1 because the L1-L3 tiers are problem-domain and cut across
providers. Provider-partitioned files arrive in Phase 2, where the subject **is** a provider's
vocabulary and packaging by provider is what keeps a projected attribute's requirement in the
provider that projects it (ADR-0050).

Note that `metaobjects/` here is nothing more than the default value of `sources`. Creating it
asserts no convention; see `docs/features/metadata-sources.md`.

### Levels are problem-domain, and the shipped doc disagrees

`@level`'s byte-gated registered description is the contract:

> 1 solution, 2 segment, 3 service, 4 object, 5 member. **L1-L3 are levels of abstraction and
> ownership in the problem domain, NOT of code structure.**

`spec/capability-ledger.md` contradicts this, defining L2 Segment as *"a major segmentation -
an application, a library, a deployable"* at scale *"app / library"*. A deployable is code
structure. The registry is byte-gated and wins.

The practical consequence is that **no per-port and no per-package L2 is admissible** - which
is the first shape a reader of that spec doc would reach for. Fixing the doc is in scope
below.

### Two roots

A functional capability map and a non-functional quality tree, as sibling roots. They are
different subtypes with opposite checks (existence versus universality), so a single root
spanning both would misrepresent one of them.

### The functional tree - pillar-anchored

L2 is the project's public four pillars, plus the two tiers the pillars presuppose but never
name: **Declare**, which is what all four consume, and **Govern the standard**, which is what
keeps five ports identical. Every other candidate axis was rejected for making the ledger's
top tier disagree with `CLAUDE.md`, the docs and the website, forcing readers to hold two
mental models of the same product.

All 59 concrete subtypes will hang under **Declare** at L4 in Phase 2. That placement is
deliberate: *"a `field.currency` stores integer minor units"* is a declaring capability, not a
codegen one.

```
L1 metaobjects
|
+- L2 declare            the model is expressed once, in typed metadata
|    L3  typedFieldVocabulary    objectTaxonomy       attributeValueTypes
|        persistenceMapping      relationships        derivation
|        constraints             presentation         declaredPrompts
|        governanceVocabulary    inheritanceAndReferences
|        authoringFrontEnds
|
+- L2 codegen            every derivable artifact is generated as code you own
|    L3  entityAndSchema         dataAccess           apiSurface
|        webClient               ownershipAndRegeneration
|        documentationAndAgentContext
|
+- L2 runtimeMetadata    metadata drives behaviour without generated code
|    L3  metadataDrivenCrud      typedQueryAndFilter
|        validationEnforcement   relationshipNavigation
|
+- L2 driftDetection     divergence is caught before it reaches production
|    L3  schemaMigration         codegenDrift
|        promptAndTemplateDrift  liveDatabaseVerification
|
+- L2 promptConstruction a prompt is code: declared, typed, rendered, parsed
|    L3  payloadProjection       deterministicRender   parserOnReceipt
|
+- L2 governTheStandard  the vocabulary is identical everywhere and changes deliberately
     L3  crossLanguageIdentity   vocabularyLifecycle   versioningAndRelease
```

The L1 and L2 statements are the design act, so they are fixed here. L3 statements are
authoring work for the plan.

**L1 `metaobjects`** - *One typed declaration of a domain model drives code, runtime behaviour
and drift checks across five languages, and what it generates keeps working with MetaObjects
uninstalled.*
Counterexample: *A model that has to be restated by hand in each language, or generated code
that stops compiling once the toolchain is removed.*

**L2 `declare`** - *A domain model is expressed once, in typed metadata, with enough fidelity
that every downstream artifact can be derived from it.*
Counterexample: *A model fact restated inside a generator, a migration or a hand-written type
because the metadata cannot say it.*

**L2 `codegen`** - *Every artifact derivable from the declaration is emitted as idiomatic
per-language code the adopter owns and may hand-edit.*
Counterexample: *An adopter hand-writing a foreign key, a CRUD route or a validator chain the
metadata already describes.*

**L2 `runtimeMetadata`** - *Metadata loaded at runtime drives behaviour with no generated code
in the path.*
Counterexample: *A dynamic admin screen that needs a code change and a redeploy to show a
newly declared field.*

**L2 `driftDetection`** - *Divergence between the declaration and what was built from it is
detected before it reaches production.*
Counterexample: *A renamed field that silently degrades a prompt, or a column the database has
and the model does not.*

**L2 `promptConstruction`** - *A prompt is code: its payload is a typed projection, its text is
external and provider-resolved, and its rendering is deterministic.*
Counterexample: *A whitespace change silently breaking an exact-prefix prompt-cache hit.*

**L2 `governTheStandard`** - *The registered vocabulary is identical in every port, changes
only deliberately, and records its retirements so they cannot be revived by accident.*
Counterexample: *One attribute meaning three different things in three ports while every gate
reports green.*

That last counterexample is the `@column` incident stated as a falsifiability test. It is the
entry the whole program exists to make checkable.

### The non-functional tree - an ISO 25010 quality tree

`requirement.architectural`, levelled. This follows the shipped guidance in
`spec/capability-ledger.md` verbatim - *"an ISO/IEC 25010 characteristic at L1, its
sub-characteristic or a control-catalogue category at L2"* - and independently matches the
established prior art, where the arc42 / ATAM quality tree refines a quality root top-down
into leaves that are concrete falsifiable scenarios. `@statement` plus `@counterexample` is
that leaf shape already.

Seven of the nine ISO/IEC 25010:2023 characteristics carry real policies here. *Functional
suitability* is omitted because the functional tree above is it, and *safety* because nothing
in scope can cause physical harm.

```
L1 quality
+- L2 compatibility     five ports behave identically; the wire contract holds
+- L2 maintainability   strict provenance; own-accessor discipline; named constants
+- L2 flexibility       generated code runs with MetaObjects uninstalled; scaffold-and-own
+- L2 reliability       fail-closed loading; every migration has a paired down.sql
+- L2 security          fail-closed filter allowlists; no credential surface
+- L2 performance       browser bundle budget; prompt-cache prefix stability
+- L2 interaction       actionable loader errors (ADR-0009); agent-facing ergonomics
```

`compatibility` is the dominant quality for this project and should be authored first: it is
the characteristic the entire conformance apparatus exists to defend, and the one the `@column`
incident violated.

### The architectural branch stops at L3, deliberately

`meta verify` errors `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` when a `live` or `partial`
architectural requirement claims nothing - a policy declared and unapplied. The check is
exempted for organisational tiers through `mayReferenceModel()`, and the guard's own comment
names this exact case: *"an 'ISO 25010 Security' at L1 delegates to its children and names
nothing."*

So L1-L3 are safe, and L4/L5 are unreachable in this repository until model nodes exist to
claim. This is a boundary to state, not a gap to apologise for: an L3 node is *"a service-grain
capability, as one testable statement"*, and *"five ports behave identically"* is testable at
L3 by the conformance corpora that already run.

### What Phase 1 proves

Authoring roughly 65 nodes exercises, under strict load: both subtypes; nesting and strictly
descending levels; a levelled architectural tree (0.23.0); the organisational-tier exemption
above; `@disposition` and `@trackedBy` on genuine open questions; and `@status: retired` with
`@supersededBy` (0.24.2), for which this repository has real subjects - the removed Java
migration engine and the removed C# migrate CLI (ADR-0015), and the OSGi runtime variant
(ADR-0012).

Every one of those is already covered by a conformance fixture, and that is the point rather
than an objection. `requirement-status-retired` is four nodes; `requirement-levels-and-nesting`
and `requirement-disposition-and-planned` are comparable. They prove the vocabulary **loads**.
None proves it is **usable** - that a real tree over a real subject can be built from it, that
the levels partition anything, or that the statements an author is forced to write are worth
having. Only authoring at scale answers that, which is why the hardest available subject was
chosen.

The gate is that `meta verify` runs clean over it in CI. A ledger that loads and verifies is
the whole deliverable.

### Explicitly out of scope for Phase 1

- L4 and L5 of any kind, and therefore all 59 subtypes (Phase 2).
- The derived-path link and the repo-local `verify` (Phase 2).
- Any code generation (Phases 3-5).
- Any new metamodel vocabulary. Phase 1 adds no types, subtypes or attributes, so
  `metamodelVersion` does not move and `expected-registry.json` is untouched.
- Any change to shipped `meta verify` behaviour. The vocabulary-coverage check considered in
  the first draft is dropped: once Phase 2 derives the ledger's shape from the registry, an
  unclaimed subtype becomes structurally impossible, so the check would be vacuous. The
  equivalent check moves upstream to "every registry entry has an authored statement".

## Drift found while specifying this, and fixed by it

Four defects, all found by reading the shipped artifacts against each other. They are fixed in
this program rather than filed, because a dogfooding program whose first act is to file
tickets against the feature it is dogfooding has not dogfooded anything.

1. **`spec/capability-ledger.md` contradicts the loader on `retired`.** It gives the enum as
   *"`planned | live | partial`"* and states *"There is no member meaning "retired": a
   requirement is prescriptive, so a capability that no longer applies is DELETED."* 0.24.2
   restored `retired` as a fourth member and registered `@supersededBy` for it, whose
   byte-gated description reads *"Legal on `@status`: retired only."* The document therefore
   denies the existence of a status the loader accepts and an attribute the registry gates.
2. **The same document still calls the attribute `violation`** in its Levels prose, renamed
   `@counterexample` in 0.24.0, while its own schema table says `@counterexample`.
3. **The same document contradicts the byte-gated `@level` description on L2**, as set out
   above. It admits deployables and libraries; the registry forbids code structure at L1-L3.
4. **`registry-manifest-exclusions.ts` says "the 11 generic `view.*` controls"**; there are 13.

## Two facts a later phase must not re-derive

- **The manifest and the spec tree count different populations.** `expected-registry.json`
  holds 69 entries (10 abstract `base`, **59 concrete**, 422 attributes);
  `spec/metamodel/*.json` declares 82. The difference is exactly the manifest's carve-outs -
  `metadata.base`, plus **13** concrete `view.*` controls classified `PresentationOnly`
  (81 - 13 + `metadata.root` = 69). Any Phase 2 denominator must state which population it
  means.
- **`spec/metamodel/*.json` already exists and is complete.** There is nothing to scaffold for
  the entries we have; scaffolding is a forward workflow for new vocabulary. The Phase 2 work
  runs the other way - the JSON exists, and requirements must be authored to cover it.

## Open questions for the plan

1. **Authoring order within Phase 1.** `compatibility` first is argued above for the quality
   tree. The functional tree has no equivalent forcing argument.
2. **Whether the ledger runs in CI's `gates` lane or its own.** It is a fast check with no
   toolchain dependency, which argues for `gates`; it is also the first repo-root
   `metaobjects/` directory, so its effect on existing suites needs verifying before wiring.
3. **Whether L3 nodes carry `@disposition` where a capability is knowingly partial.** Several
   will be - the MCP exposure of declared prompts is the clearest - and `deferred` requires a
   `@trackedBy` reference to avoid `WARN_REQUIREMENT_DEFERRED_UNTRACKED`.
