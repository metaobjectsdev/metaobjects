# Architecture Decision Records (ADRs)

This directory records **significant, cross-cutting architectural decisions** for the MetaObjects standard — the durable "why" that outlives any single feature spec.

## What goes here vs. elsewhere

| Doc type | Location | Scope |
|---|---|---|
| **ADR** | `spec/decisions/` *(here)* | Durable, **cross-cutting, target-agnostic** contracts that bind multiple language ports (e.g. how metadata→native types are bound; the conformance model; persistence-engine choice). |
| Feature design (FR spec) | `docs/superpowers/specs/` | A single feature's design, language- or area-scoped. |
| Implementation plan | `docs/superpowers/plans/` | Task-by-task execution of a feature. |
| Conventions / pointers | `CLAUDE.md` | Lean, always-loaded context: durable one-liners + pointers here. |

## When to write an ADR
Write one when a decision is **cross-cutting** (affects more than one language port or more than one feature) and **durable** (future work must respect it). Examples: a metamodel binding contract, the wire-format guarantee, "migrations decoupled from the runtime." Do **not** write ADRs for feature-level or easily-reversible choices — those live in the FR spec.

## Format
[Michael Nygard's ADR format](https://github.com/joelparkerhenderson/architecture-decision-record): **Context → Decision → Consequences → Status**, plus *Alternatives considered* and *Realization status* where useful. One decision per file. Status is `Proposed` | `Accepted` | `Superseded by ADR-NNNN`. Numbered sequentially; never renumber (supersede instead).

## Index
- [ADR-0001 — Cross-language metadata→native-type binding](ADR-0001-cross-language-type-binding.md) — *Accepted*
- [ADR-0002 — Open-Closed typed nodes (subtype behavior on the class)](ADR-0002-open-closed-typed-nodes.md) — *Accepted*
- [ADR-0003 — Metamodel constants colocation](ADR-0003-metamodel-constants-colocation.md) — *Accepted*
- [ADR-0004 — Provider-based type registration & composition](ADR-0004-provider-based-type-registration.md) — *Accepted*
- [ADR-0005 — Object representation: entity/value semantics + binding-resolved representation (OO ports)](ADR-0005-object-representation-binding.md) — *Accepted*
- [ADR-0006 — AI-first YAML authoring (sigil-free YAML; JSON stays canonical)](ADR-0006-ai-first-yaml-authoring.md) — *Proposed*
- [ADR-0007 — Source metatype v2: storage-paradigm subtypes, logical names, multi-source, per-subtype physical addresses](ADR-0007-source-v2-paradigm-subtypes-multisource.md) — *Proposed*
- [ADR-0008 — Parameter-passing for generated repo helpers](ADR-0008-parameter-passing-generated-repo-helpers.md) — *Accepted*
- [ADR-0009 — Loader error envelope + source-on-node](ADR-0009-loader-error-envelope-and-source-on-node.md) — *Accepted*
- [ADR-0010 — Per-port parser-on-receipt codegen for `template.output`](ADR-0010-template-output-parser-codegen.md) — *Accepted*
- [ADR-0011 — `template.toolcall` as a core MO subtype](ADR-0011-template-toolcall-as-core-subtype.md) — *Accepted*
- [ADR-0012 — Remove the OSGi runtime variant from the Java port](ADR-0012-remove-osgi-runtime-variant-java.md) — *Accepted*
- [ADR-0013 — Logical field types vs. physical column-type attributes](ADR-0013-logical-field-types-vs-physical-column-attributes.md) — *Accepted*
- [ADR-0014 — Type-registry resolution is loader-scoped, not process-global](ADR-0014-loader-scoped-type-registry-resolution.md) — *Accepted*
- [ADR-0017 — Cross-port runtime object model (ValueObject default + MetaObjectAware + self-registering ObjectClassRegistry + newInstance factory)](ADR-0017-cross-port-runtime-object-model.md) — *Accepted*
- [ADR-0018 — Per-kind physical-name attributes within source paradigms](ADR-0018-per-kind-physical-name-attrs.md) — *Proposed*
