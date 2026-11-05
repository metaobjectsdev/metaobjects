# ADR-0023 — Strict metadata provenance: no made-up attributes

**Status:** Accepted (2026-06-04)
**Renumber note:** drafted as ADR-0022; renumbered to **ADR-0023** because a sibling session had a prior, shipped claim on ADR-0022 (codegen-and-docs-surface-architecture). The strict-attr commits in this branch carry immutable `ADR-0022` labels in their messages; all artifacts use **ADR-0023**.
**Deciders:** human (project owner) + Claude
**Relates to:** ADR-0001 (build-time type binding; no runtime-classpath-dependent resolution), the SP-G registry-conformance gate (the cross-port "agreed vocabulary" = `fixtures/registry-conformance/expected-registry.json`), and the SP-G Unit-8 finding that codegen generators self-register attributes into the global JVM registry.

## Context

The metamodel vocabulary (every `type.subType` + its attributes) is the durable cross-port spine. It is byte-gated across all five ports by registry-conformance. But two holes let **made-up attributes** enter without human agreement or cross-port gating:

1. **Open-attr load policy.** Every port's loader currently *accepts* an authored `@attr` that no provider declares (it silently materializes it). So a typo or an ad-hoc attribute passes load — and codegen/runtime can then read it — with no gate.
2. **Codegen self-registration (JVM).** Codegen generators (`MetaDataAIDocumentationGenerator`, `MetaDataFileJsonSchemaGenerator` in `codegen-base`; `OMMetaDataProvider`'s `object.managed`) register `ai*`/`json*`/`has*` attributes + a subtype into the **process-global** `MetaDataRegistry` via SPI on classpath presence. The runtime loader defaults to that polluted singleton, so authored metadata using those attrs would load successfully — yet they were never agreed metamodel vocabulary, and the registry-conformance gate only stays clean by *measuring a defined provider subset* (a test-only workaround), not by forbidding the pollution.

A related anti-pattern this rules out: inventing a metamodel attribute for a value that can already be **computed** from existing metadata (e.g. `@joinFields` — derivable from the junction's `identity.reference`; field-level validation attrs — expressible as `validator.*` children; `field.class` — covered by `field.object` + `@object`). Each such "attribute" is redundant SSOT that drifts.

## Decision

**For the metaobjects library itself, undeclared metadata is never allowed. Enforced structurally by strict-load + a sealed registry; governed by a human-agreement rule.**

### 1. Strict load (library default `strict: true`; downstream may loosen)
The loader, in strict mode, **throws** on any authored type/subtype/attribute that is not declared by a registered provider:
- unknown type → `ERR_UNKNOWN_TYPE`, unknown subtype → `ERR_UNKNOWN_SUBTYPE`, **undeclared attribute → `ERR_UNKNOWN_ATTR`** (closing the open-attr policy in all ports).
The library always loads strict (its conformance corpora must use only declared vocabulary). A **downstream app may set `strict: false`** to tolerate unenforced attributes/types it hasn't declared.

### 2. Sealed registry (the agreed vocabulary is closed after bootstrap)
After the agreed metamodel providers bootstrap, the registry is **sealed**: any further registration (`register`/`extend`/`registerCommonAttr*`/`addConstraint`/`registerType`/etc.) throws `ERR_REGISTRY_SEALED`. Consequences:
- **Codegen generators MUST NOT register metamodel attributes.** Under a sealed registry their self-registration throws. The `ai*`/`json*`/`hasAuditing`-style attrs are codegen *tooling*, not metamodel vocabulary — they are **removed from the registry** (the generators compute what they need locally), not promoted to the canonical.
- **JVM load-time pivot:** the library loader defaults to the **sealed, defined-provider-set** registry (the SP-G `metamodelProviders()` set — promoted from a test-only measurement device to the runtime default), NOT the unbounded global `getInstance()` SPI scan. This is also the ADR-0001-consistent fix (no classpath-dependent vocabulary; AOT-safe). The existing `loader.setTypeRegistry(compose(... + myProvider))` seam stays the sanctioned downstream extension path.

Together, made-up attributes become **structurally impossible** in the library: code cannot register post-bootstrap, data cannot use an unregistered attribute, and because codegen only reads attributes off loaded nodes, it can only ever see the agreed vocabulary — no codegen-read instrumentation needed.

### 3. Governance — adding a metamodel attribute
A new metamodel attribute (or type/subtype) requires ALL of:
1. a **registered metamodel provider** declaring it (so it enters the cross-port registry-conformance canonical — a deliberate, reviewed commit);
2. **human agreement** (the canonical/provider change is reviewed by the project owner);
3. a **written justification** for why it is needed AND **why its value cannot be computed** from existing metadata. Claude must make this case explicitly; "it can be computed" is a rejection.

### 4. Downstream extensibility (preserved)
Downstream apps may register their own providers (extending the registry before sealing / via the `setTypeRegistry` seam) and/or loosen strict-load to carry unenforced attributes. The strict+sealed contract applies to the **library's** conformance, not to adopters.

## Consequences

- **Hard-fail gate:** a conformance test boots the library strict+sealed and asserts (a) authored undeclared metadata is rejected, (b) a codegen generator attempting to register a metamodel attr throws. A made-up attribute fails the build.
- The doc-generator `ai*`/`json*`/`object.managed` vocabulary leaves the metamodel registry (computed/codegen-time-only). The SP-G `composeMetamodelRegistry()` becomes the runtime default, not a test workaround — the registry gate now measures the real (clean) registry.
- Strict-attr load is a behavior change in all five ports; the library's own fixtures must use only declared vocabulary (turning strict on surfaces any made-up attrs in our corpora — a feature, not a regression). Downstream consumers relying on unenforced attrs set `strict: false`.
- Cross-port: a shared strict-load conformance fixture proves identical reject behavior in all five ports; the registry-conformance canonical remains the single agreed vocabulary.

## Alternatives considered
- **Runtime codegen-read instrumentation** (record every attr a generator queries, fail undeclared). Rejected: strict-load + sealed-registry makes undeclared attrs unreadable by construction, so instrumentation is unnecessary.
- **Seal the global singleton as-is** (JVM). Rejected: it would freeze the *polluted* vocabulary; the loader must default to the defined-provider set instead.
- **Static attr-name-constant provenance scan.** Useful as a lint but fragile (misses dynamic reads); the structural approach is stronger.

## Amendment 1 (2026-11-04): the 1.3 schema vocabulary, justified

Section 3 asks for a written case, per attribute, that its value cannot be computed from the
metadata already there. The 1.3 release adds the vocabulary below. Each one states a fact about a
database or a rule that the model has no other way to know; each derived default stays as it was,
so a model that declares none of them emits what it always did.

- **`@flattenedColumnPrefix`** (on a `field.object` with `@storage: flattened`). The default is
  computed: the field's resolved column and `_`. What cannot be computed is an existing table that
  used another prefix, or none at all, and a value object embedded twice on one table with a
  different prefix each time. `@column` on the field cannot say it: `""` is not a column name, and
  the prefix belongs to the embedding, not to the value object, which other tables embed too.
- **`@sequenceStart` and `@sequenceName`** (on an `@generation: increment` `identity.primary`).
  The first value a sequence hands out and its physical name are facts of a database that already
  exists: a low id range kept for seeded rows, a sequence that kept its name across a table
  rename. Nothing in the model implies either. They are not `@dbColumnType`, which spells a
  column's type and is own-only: these are options of the identity's sequence, compared and
  altered in place by `meta migrate`, and they keep their meaning when the column type changes.
  Postgres only; SQLite and D1 have no sequence, and migrate says so when it creates such a key.
- **`@constraintName`** (on a validator that generates a CHECK, and on a string-stored
  `field.enum`). The derived name (`<table>_<column>_<kind>_chk`) stays the default. The declared
  one is a name an adopter chose: a database whose CHECKs were named by hand, or a program that
  compares a violation against the constraint name. A chosen name cannot be derived.
- **`@condition`** (on the cross-field validators: `comparison`, `requiredWhen`, `presentIff`,
  `atLeastOne`, `exactlyOne`). A rule that holds only in some case
  ("a refund needs a reason") is a guard the author states; no other metadata says when a rule
  applies. It uses the existing `attr.expression` grammar, so no new expression language comes
  with it.
- **`validator.exactlyOne`** (a subtype, per ADR-0037). "Exactly one of these fields is set" has
  its own SQL form (`num_nonnulls(...) = 1`) and its own record-model check, so it is a thing with
  its own behaviour, not a variant of `atLeastOne`. The first draft spelled it `atLeastOne` with
  `@max: 1`, which overloaded `@max` (numeric everywhere else) and read against the validator's
  name; that never shipped. It cannot be computed: nothing else in the model bounds how many of a
  set of fields may be set.
- **`@maxLength` on `field.enum`**. The longest member could size the column, but then adding a
  longer member would silently become a column type change, and the width an existing database
  already uses (a `VARCHAR(32)` sized for growth) is a physical fact the member list does not
  carry. The project-wide default (`enums.maxLength`) is configuration, not vocabulary. Absent
  both, the column stays unbounded text, as before.
- **`field.duration`** (a subtype, per ADR-0037). A fixed-length span has its own native type in
  four ports (`TimeSpan`, `java.time.Duration`, `timedelta`) and in Postgres (`interval`), its own
  wire grammar and its own ordering. A `field.string` or a `field.long` holding a count cannot carry
  the unit or the native type, so it is a subtype, not an attribute.
