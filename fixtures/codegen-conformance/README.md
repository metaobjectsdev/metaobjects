# `codegen-conformance/` — PENDING (FR-007)

> ⚠️ **This corpus does not exist yet.** It is **DEFERRED** and tracked as **FR-007**.

Cross-language codegen conformance is the one shared-corpus gap in the MetaObjects testing matrix. Other corpora exist (`conformance/`, `render-conformance/`, `persistence-conformance/`, `verify-conformance/`, `yaml-conformance/`). This one will gate **what** each port's codegen emits — file inventory, type-mapping semantics, FR-004 payload-VO shape — independently of *how* (each port emits its own ecosystem's native code).

## Status

- **Spec:** [docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md](../../docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md)
- **Blocked on:** `codegen-kotlin` shipping (the 4th codegen target — 3rd is TS, C# already shipped; Java's codegen-base is general-purpose but doesn't have an FR-004-typed payload generator).
- **Helped by:** Python codegen, when it ships, becoming the 5th port that needs to participate.

## What this corpus will gate

**Tier 1 (cross-port invariant):**
- File-per-entity inventory per declared generator
- Field type semantic mapping (`field.long` → 64-bit int everywhere; `field.currency` → minor-units long everywhere; etc.)
- Required vs nullable flags
- `@maxLength` propagation to the appropriate native column type
- FR-004 payload-VO field tree (each port's generated payload class has the same property names + semantic types)
- Generator-catalog membership (every port implements the same generator names)

**NOT gated (intentionally divergent per port):**
- Native column type spelling
- Native repo / ORM style (Drizzle relations vs EF Core DbSet vs Exposed Table vs omdb-ktx extensions vs SQLAlchemy)
- Native serialization annotation
- Native package / module naming conventions
- Native framework integration

## Why this README exists

To make the gap **impossible to miss**. If you're reading this because you stumbled into this directory while building a new codegen target or looking for cross-port codegen tests — that gate doesn't exist yet, and the spec above is the plan-of-record for when it does.

Until then, each port runs its own codegen snapshot tests against port-local golden files. Drift between ports is undetected.

## Do not delete this README

Even when the corpus eventually ships (per FR-007), keep this README to point newcomers at the design spec.
