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
