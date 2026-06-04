# ADR-0022 — Strict metadata provenance: no made-up attributes

**Status:** Accepted (2026-06-04)
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
