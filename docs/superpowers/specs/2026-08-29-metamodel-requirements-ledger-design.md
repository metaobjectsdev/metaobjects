# The metamodel as its own requirements ledger

**Status:** design approved in chat 2026-08-29; P1 spec, P2/P3 shaped only.

## Why

Five ports hand-write their provider registrations — 69 `type.subType` entries carrying
422 attributes, five times over — and `fixtures/registry-conformance/expected-registry.json`
exists to reconcile them after the fact.

That gate byte-matches **vocabulary**. It is blind to **behaviour**, and the blindness is
measured, not theoretical. On 2026-08-29 a single attribute, `@column`, was found to mean
three different things across the ports: Python's read model used it as the *Pydantic field
name*, Kotlin's Exposed generator *ignored it entirely* while hardcoding snake_case, and
Java's runtime resolved it literal — one model, two column names, one JVM. Every port
byte-matched the manifest throughout. Earlier instances of the same class: `like`
case-sensitivity (four releases), int-backed `field.enum` codecs (two ports composing,
four silently wrong), `{{#hasField}}` (all five ports, no fixture existed).

The manifest proves the ports *spell* the vocabulary identically. Nothing states what the
vocabulary must **do**, so nothing can be gated on it.

## Program

Three phases. Each is independently valuable; each is a separate spec and plan.

- **P1 — the ledger** (this document). Model the metamodel as `requirement.*` nodes,
  packaged by provider, with a gate that fails when a registered subtype is unclaimed.
  Output: a loadable ledger and a coverage check. Nothing generated yet.
- **P2 — generate what is hand-coded.** The ports' provider-registration code becomes
  generated output driven by `spec/metamodel/*.json`, which is already the structural
  source of truth and is *already* byte-copied into `server/csharp/MetaObjects/SpecMetamodel/`
  and `server/python/src/metaobjects/spec_metamodel/`. `expected-registry.json` becomes a
  derived artifact rather than a reconciliation point.
- **P3 — the harness.** Per-port test scaffolds generated from the P1 ledger, verifying
  that metadata using a subtype loads and that the port implementing it behaves. P3 rides
  P2's per-port generator rails rather than building its own, which is why it is last.

P1 is a prerequisite for P3 and independent of P2.

## P1 design

### The ledger is normal metadata

No new vocabulary. `requirement.functional` and `requirement.architectural` as shipped;
the ledger loads through the same loader, under the same strict registry, as any adopter's.
This is the project's first ledger of its own — the requirement feature ships today without
the repo dogfooding it over its own metamodel.

### Packaging is by provider; levels are problem-domain

Two orthogonal axes, and conflating them is the trap.

**Package = provider.** One file per provider under a repo-root `metaobjects/`:

    metaobjects/meta.core-types.yaml     package: metaobjects::coreTypes
    metaobjects/meta.db.yaml             package: metaobjects::db
    metaobjects/meta.prompt.yaml         package: metaobjects::prompt
    metaobjects/meta.ui-web.yaml         package: metaobjects::uiWeb
    metaobjects/meta.documentation.yaml  package: metaobjects::documentation

This is not cosmetic. Four of the six providers declare **zero types** — they project
*attributes* onto types another provider owns (ADR-0050). Packaging by provider is what
makes a projected attribute's requirement sit in the provider that projects it rather than
the one that owns the type, which is the distinction FR-033 broke once, leaving
`template.prompt` registered with no attributes at all and `ERR_MISSING_REQUIRED_ATTR`
silently unable to fire.

YAML, not canonical JSON: 59 hand-authored prose statements are the case ADR-0006's
sigil-free authoring front-end exists for.

**Levels stay problem-domain.** `@level`'s own registered description says L1–L3 are
levels of abstraction and ownership *"NOT of code structure"* and never *"a directory,
package, deployable or module"* — and a provider is a module. So the provider appears as
the package and never as a level.

### The level mapping

`requirement-check.ts` enforces `level <= parentLevel` as `ERR_REQUIREMENT_LEVEL_NESTING`
("a child sits strictly below its parent") with a ceiling of 5. Five strictly-descending
tiers is the entire budget:

| Level | Registered meaning | Metamodel |
|---|---|---|
| 1 | solution | the standard — one root node |
| 2 | segment | pillar: codegen / runtime metadata / drift detection / prompt construction |
| 3 | service | capability group: "typed field vocabulary", "persistence mapping", "the object taxonomy" |
| 4 | **object** | **a concrete subtype** — `field.currency` |
| 5 | **member** | **a promise-bearing attribute** — `@currency`, `@intValueMap` |

The tempting mapping (L4 = type `field`, L5 = subtype `field.currency`) is wrong twice
over: it leaves promise-bearing attributes with nowhere legal to nest, and a bare type is
not prescriptive on its own — `field` promises nothing that `field.currency` does not
promise better. Subtype-as-object and attribute-as-member also reads correctly against the
registered meanings of L4 and L5.

### Granularity

One L4 requirement per **concrete** subtype: 69 registered entries minus 10 abstract
`base` subtypes = **59**.

L5 children only for attributes that carry their **own falsifiable promise** —
`@intValueMap`, `@column`, `@lenient`, `@storage`, `@currency`. Most of the 422 attributes
merely configure their subtype and fail FR-038's prescriptive bar standing alone; an
entry per attribute would manufacture exactly the non-prescriptive filler that FR-038
retired half the vocabulary to prevent.

### What a requirement says

`@statement` and `@counterexample` are both required, and `@counterexample` must be a
static falsifiability test. That bar is the point of the exercise: it forces the question
"what does this vocabulary actually promise?" for all 59, which is the question nobody
had to answer when `@column` was registered.

    - requirement.functional:
        name: currencyIsIntegerMinorUnits
        title: Money never touches a float
        level: 4
        status: live
        statement: "A field.currency stores and transmits an integer count of minor
          units, so no arithmetic on money can lose a cent to binary floating point."
        counterexample: "A price column typed double, where 0.1 + 0.2 is not 0.3."
        children:
          - requirement.functional:
              name: localeIsClientSideOnly
              level: 5
              status: live
              statement: "@locale selects client-side formatting; the server emits
                minor units regardless of it."
              counterexample: "A response body carrying a formatted string like
                '$49.99' instead of 4999."

**`@implementedBy` is omitted.** It is optional (`min=0`) and legal only at L4/L5, but its
referent is a *model node* and these requirements' subject is the vocabulary itself —
there is no entity to name. Omitting it is legal and produces no dangling-reference error.
What proves a requirement holds is P3's generated test, linked by derivation rather than
declaration.

**`@verifiedBy` is not coming back.** It was retired in 0.24.0 after 0.23.1 found its
closed pattern list guessing at other repos' test conventions and convicting a correct
project on Maven Failsafe. The existing `requirementTests()` generator already shows the
replacement: the test *identity* is derived from the requirement name plus the claiming
node (`subscriberCanBePausedWithoutErasingHistory.field.enum.test.ts`), the body is
hand-written and survives regeneration, and the generated header states the contract —
*"Do not rename the test — the name is the link."* Derivation cannot repeat declaration's
mistake, because the generator owns the name and has nothing to guess.

### The gate

A new `meta verify` check: **every concrete registered subtype is claimed by an L4
requirement.** Its input is `expected-registry.json` (the manifest that already knows the
complete concrete vocabulary) matched against the ledger.

Day one it is a **WARNING**, for the same reason object coverage shipped as one: on a real
ledger it reports 59 unclaimed subtypes, and an error would fail the repo's own build from
the moment the first requirement is authored. It is promoted to an error in the commit that
brings the count to zero, and that promotion is the definition of P1 being finished.

Deliberately NOT gated in P1: that a requirement has a test (that is P3), and that the
statement is any good (no machine can check prose).

### Explicitly out of scope for P1

- Any code generation (P2).
- Any test scaffolding (P3).
- Any new metamodel vocabulary. P1 adds no types, no subtypes, no attributes, so
  `metamodelVersion` does not move and `expected-registry.json` is untouched.
- Architectural requirements. P1 is `requirement.functional` only; cross-cutting policies
  ("every port resolves a column name through one shared helper") are a natural follow-on
  but need the universality check thought through separately.

## Open questions for the plan

1. **Authoring order.** 59 statements is the bulk of the work. Provider by provider
   (`core-types` alone is 81 of the 82 type entries), or pillar by pillar?
2. **Seeding.** Each registry entry already carries a byte-gated `description` and most
   carry `whenToUse`. Those are *descriptive*; requirements must be *prescriptive*. Seeding
   gives a starting point per node, never an answer — is a seeded draft worth it, or does
   it invite rubber-stamping descriptions as requirements?
3. **L2/L3 shape.** The four pillars are the obvious L2. L3 needs a real cut of ~59
   subtypes into capability groups, and that cut is a design act, not a mechanical one.
4. **Where the 10 abstract `base` subtypes go.** They are not claimable at L4 (nothing
   concrete), but `field.base` does carry promises its concretes inherit. Candidate: they
   are the L3 nodes.
