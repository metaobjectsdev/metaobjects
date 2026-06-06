# ADR-0021: Codegen surface coherence — one front door, stable-name registry, consistent verify

> **⚠️ Superseded by [ADR-0022](ADR-0022-codegen-and-docs-surface-architecture.md)**
> (consolidated codegen + documentation surface architecture). Kept as a
> historical record; ADR-0022 is the current canonical statement.

**Status:** Superseded by ADR-0022
**Extended by ADR-0025:** D1 (the single docs door) now covers ALL documentation, via two cross-linked surfaces (`model` / `api`) — see [ADR-0025](ADR-0025-unified-docs-door.md).
**Date:** 2026-06-02
**Relates to:** ADR-0020 (codegen tiering), ADR-0015/0016 (migrate engine)

## Context

A god-level architecture review (2026-06-02), benchmarked against protoc/Buf,
Smithy, Prisma, jOOQ, Nx, and OpenAPI Generator, reached a clear conclusion: the
project's **per-port native generator count (~71) is principled and correct**
(Smithy/protoc converge on "shared model + per-language generators at the edge";
native idiomatic output is the 2025-26 best practice). The confusion is **not**
the generator count — it is the **cross-cutting surface**:

1. **Four different ways to select which generators run:** TS `defineConfig`
   `generators[]` array (factory functions), Java/Kotlin fully-qualified class
   names in `pom.xml` XML, C# a hardcoded default suite of 4 (5 generators exist
   but are unreachable from the CLI), Python a hardcoded suite of 7.
2. **`verify` means different things per port:** TS/C# = template/prompt drift;
   Java/Python = codegen drift; `--db` = schema drift (TS only). Not parallel.
3. **Docs emit two ways:** the `docsFile` generator inside `meta gen` AND the
   standalone `meta docs` command, with different contexts that can diverge.
4. **Two Java Mustache generators:** legacy `codegen-mustache/
   MustacheTemplateGenerator` (old `Generator` interface, Maven-pluggable) and
   the new conformance-pinned `render/templategen/TemplateGenerator`.
5. No **discoverability**: no `--list` of available generators + their options.

The research names the fix: **one front door + a uniform generator contract +
declared options + a discoverable registry** (protoc's plugin contract, Smithy's
directed codegen, Nx's generator registry). This is what keeps "native per-port +
many artifacts" from becoming "too many ways to do it."

## Decision

### D1 — `meta docs` is the single door for documentation
Documentation is a Tier-2 neutral artifact (ADR-0020). It must NOT be reachable
through the Tier-1 `meta gen` pipeline. **Deprecate `docsFile` as a config-list
generator** (it stays as the internal engine `meta docs` calls; it is removed
from the recommended/public generator surface with a deprecation note). One door,
no divergent-context risk. Same reasoning that moved the Mermaid ER diagram into
the neutral docs engine (ADR-0020 / docs-hardening).

### D2 — `verify` unifies to explicit subverbs across ports
One vocabulary everywhere, each port implementing the modes it supports:
- `verify --db` — schema drift (live DB / snapshot). (migrate engine; Node today.)
- `verify --codegen` — regenerate-to-temp and diff against committed output.
- `verify --templates` — template/prompt `{{field}}`↔payload drift (the render
  `verify()` gate).
A bare `verify` keeps a documented default per port (back-compat) but the
explicit subverbs are the contract. C#'s current `verify` (template drift)
becomes `verify --templates`; ports add `--codegen` for parity over time.

### D3 — Uniform generator selection by STABLE NAME + a registry + `--list`
Generators are selected by a **stable string id** (e.g. `entity`, `routes`,
`render-helper`, `extractor`), not by language-specific factory imports / FQNs /
hardcoded suites. Each port exposes:
- a **registry**: stable-name → generator factory (+ a declared option schema and
  a one-line description),
- `--list` (e.g. `meta gen --list` / `meta generators`) that prints every
  available generator, its description, and its options — the discoverability
  surface,
- config/selection by stable name (the TS config may still pass options; the
  point is the *name* is the stable, cross-port-consistent identity).
This is the protoc/Smithy/Nx coherence mechanism. It does NOT change the
generated output or the per-port idiomatic emission — only how generators are
*identified, discovered, and selected*.

### D4 — Deprecate the legacy Java Mustache generator
`codegen-mustache/MustacheTemplateGenerator` is deprecated in favor of the
cross-port conformance-pinned `render/templategen/TemplateGenerator`. Kept working
with an `@Deprecated` + javadoc note; removed in a later major.

## Scope of THIS change (reference-first, per the chosen approach)

Implement the **reference in TypeScript** + the **contained cross-port fixes**;
**stage** the full fan-out:

- **TS (reference):** a stable-name generator **registry** + `meta gen --list`;
  reconcile `verify` to `--db`/`--codegen`/`--templates`; enforce D1 (deprecate
  `docsFile` from the public generator surface; `meta docs` is the door).
- **C# (contained fix):** expose the 5 generators the CLI omits — drive selection
  from the registry/config so RenderHelper/Extractor/OutputPrompt/FilterAllowlist/
  Template are reachable, and add `--list`.
- **Java (contained fix):** `@Deprecated` on the legacy Mustache generator.
- **Docs:** update `docs/features/cli.md` — the `verify` subverb contract, the
  one-door docs rule, the generator-registry/`--list` model, the staged status.

### Staged (follow-on, NOT this change)
Fan out the stable-name registry + `--list` + `verify` subverbs to Java, Kotlin,
Python (and Maven plugin / dotnet / python CLIs); converge the generator-selection
config mechanism so all ports select by the same stable names. Each is its own
gated slice.

## Consequences
- One discoverable, consistent way to find and select generators (the research's
  coherence mechanism), without touching the principled per-port emission.
- `verify` becomes predictable across ports.
- Docs have exactly one door, consistent with ADR-0020.
- A contributor adding a generator registers a stable name + options + a
  description — it shows up in `--list` automatically.
- The full cross-port convergence is sequenced, not big-bang, so each port stays
  green behind its conformance gates.
