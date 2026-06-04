# `codegen-conformance/` — REJECTED (FR-007 will not be built)

> ⚠️ **This corpus is NOT going to be built.** FR-007 was **formally rejected 2026-05-26**
> (`docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md` §0), and the
> 2026-05-31 conformance-hardening pass (A/B) re-confirmed the rejection with empirical evidence.
> This README is kept only so a newcomer who lands here understands *why* there is no codegen
> corpus, instead of re-proposing one.

## Why it was rejected

A dedicated cross-port **codegen-output** corpus would add ~0 net coverage at real maintenance cost,
because **codegen is a substrate and the behavior corpora already gate its observable consequences**:

- Field-type semantics (`field.long`→64-bit, `field.currency`→minor-units long), required/nullable,
  and `@maxLength` propagation are gated by **`persistence-conformance/`** executing the generated
  DDL + queries — a wrong mapping explodes there.
- The FR-004 payload-VO field tree is gated by **`render-conformance/`** (a missing/renamed VO field
  changes the byte-identical rendered output).
- Generated validators, filters, and routes are gated by **`api-contract-conformance/`**.
- "Generator-catalog membership" was a false premise — each port's catalog is idiomatic-divergent by
  design (TS `entityFile/queriesFile/...` ≠ C# `entities/AppDbContext/routes` ≠ Kotlin
  `Entity/ExposedTable/Payload/...`); there is no shared catalog to gate.

**Empirical confirmation (2026-05-31):** the Phase-B normalization+projection work surfaced a real
*codegen* bug in **every** port (C#'s MIN/MAX projection result-type + enum-over-view conversion,
Kotlin's missing `TimeField` arm, etc.) — and every one was caught by the **behavior** (persistence
round-trip) corpus, exactly as the rejection predicted. Codegen drift that matters shows up in
behavior; codegen drift that doesn't is, by definition, not a correctness issue.

## The one residual gap — handled opportunistically, not by a corpus

Codegen/type drift *could* go uncaught for vocabulary **no behavior corpus exercises** — the
"type-universe-shrinks" long tail (`validator.{length,regex,numeric,array}`,
non-cascade `@onDelete`/`@onUpdate`, `@kind: storedProc|tableFunction|materializedView`, the
`view.*` UI subtypes). This is the lowest-priority backlog tier (hardening-review **R10**), and it is
closed the project's normal way: **adding new metamodel behavior ⇒ add a behavior-corpus fixture that
exercises it** (`spec/conformance-tests.md`). No standing codegen-manifest corpus is needed; add a
persistence/api-contract fixture when one of those types/validators is touched.

## Do not delete this README / do not re-propose FR-007

Keep this file so the gap-that-isn't stays documented. If you believe a codegen corpus is warranted,
the bar (per the rejection) is **a concrete codegen-drift incident that slipped past the behavior
corpora** — not a coverage-completeness argument.
