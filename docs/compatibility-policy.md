# Compatibility policy

This is the stability promise MetaObjects makes at **1.0** (Metamodel 1.0). It defines
what SemVer covers, what it does not, and how versions work across the language ports.
The governing decision is [ADR-0035](../spec/decisions/ADR-0035-one-zero-stability-commitment-and-version-unification.md).

## The core idea: a spec version, not one package number

The durable, promised contract is the **Metamodel spec version** — e.g. *Metamodel
1.0*. Every language port advertises which spec version it implements, and the
cross-port conformance corpora verify that claim byte-for-byte. Package versions are
**ecosystem-natural and independent**:

| | Package version at the 1.0 cut | Promise it carries |
|---|---|---|
| npm / PyPI / NuGet | `1.0.0` | implements **Metamodel 1.0** |
| Maven Central (Java / Kotlin) | `8.0.0` | implements **Metamodel 1.0** |

The two package lines then move forward independently in their own registries; the
**Metamodel spec version** is the number that communicates cross-language parity and
carries the compatibility promise. (This is the OpenTelemetry / Protobuf-editions
model. The Java `7.x → 8.0` step is a forward major — package versions never move
backward, a hard rule on every registry.)

## What is covered (breaking change ⇒ next MAJOR)

After 1.0, a breaking change to any of the following requires a **new major of the
Metamodel spec version** (Metamodel 2.0) and a major bump of every affected package:

- **The metamodel vocabulary** — the registered type / subtype / attribute set,
  enforced by `registry-conformance`. This is the durable spine.
- **The canonical authoring + interchange format** — canonical JSON keyword/`@`-attr
  rules, sigil-free YAML, the `extends` / `@via` grammar, package `::` syntax.
- **The wire / normalization contract** — the cross-port serialized form (currency
  minor units, pagination, the native-return-type contract, jsonb parsed-value).
- **The CLI command surface** — `init` / `gen` / `verify` and their *documented*
  flags, per port (`meta`, `dotnet meta`, `mvn metaobjects:*`, `metaobjects`).
- **The scaffold-and-own contract** — what `meta init` scaffolds and the `Generator`
  interface owned templates implement.

## What is NOT covered (may change in a MINOR)

- **Generator internals and the reference templates themselves.** Generated code is
  yours and disposable — its internals are not a public API. See
  [own-your-codegen](features/own-your-codegen.md).
- **Runtime-library helper internals.** Idiomatic per port; best-effort, not promised.
- **Anything explicitly marked experimental or reserved** and not yet in the registry
  (e.g. the reserved-but-unregistered declared-API vocabulary `api.*`/`operation.*`/
  `binding.*`, and reserved index subtypes `index.fulltext`/`vector`/`spatial`).

## MINOR vs. PATCH (what a version bump means)

The trigger is **new public surface, not code size**:

- **MINOR** — adds surface a consumer can newly depend on: a new generated artifact,
  a new CLI flag, or a newly-supported metamodel member. Additive; never breaking.
- **PATCH** — a bug fix or internal refactor with no new surface.
- **Metamodel spec-version bump** — only when the shared vocabulary or wire/canonical
  contract itself changes. Most releases are per-port package moves that do *not*
  touch the spec version.

## Spec-version support across ports

All ports that ship a given release implement the **same** Metamodel spec version,
verified by the shared conformance corpora (metamodel, render, persistence,
api-contract, registry). A port's package version tells you its own fix/feature level;
its declared `metamodelVersion` tells you the contract it honors. When they differ,
the spec version is authoritative for cross-language interop.

## Pre-1.0 (today)

Until the 1.0 cut, the project is in `0.x` (npm/PyPI/NuGet) / `7.x` (Maven) and the
public API is not yet frozen — breaking changes may ship in a minor, as they did
through the `0.14`–`0.15` vocabulary-finalization window. The
[1.0 readiness checklist](1.0-readiness.md) tracks the remaining path; the
[0.x → 1.0 migration guide](features/migrations/0.x-to-1.0.md) consolidates the
breaking changes adopters absorb at the cut.
