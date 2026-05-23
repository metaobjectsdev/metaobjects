# ADR-0001 — Cross-language metadata→native-type binding

**Status:** Accepted — 2026-05-22
**Applies to:** all language ports (TS, Java, Python, C#)
**Related:** the OMDB persistence work (`docs/superpowers/specs/2026-05-22-fr-003-*`); `spec/metamodel.md`; `spec/conformance-tests.md`

## Context

Metadata is **language-agnostic**: an object is identified by a fully-qualified name (FQN) like `myapp::commerce::Program`. At runtime and/or codegen time, each language must bind that FQN to its native representation — the generated class to instantiate (OO ports), or the generated module/schema to use (data-oriented ports). The question is *how*, in a way that is consistent across languages, survives modern toolchains, and doesn't pollute the metadata.

Three naive approaches fail:

- **Runtime reflection by name** (`Class.forName` / `Type.GetType` / `importlib`): impossible in TS/JS (no runtime "class from string" reflection), and increasingly broken in Java/C# by **GraalVM native image** and **.NET Native AOT / trimming**, which remove reflection at build time. The industry is actively moving *away* from this (Spring AOT generates reflection-free hints; `System.Text.Json` requires source generators and lets you disable reflection entirely).
- **A single global registry**: doesn't scale — codegen runs **per package/domain/target**, often into separate artifacts/jars; one monolithic registry can't be assembled from independently-generated slices.
- **A hand-maintained (or generated-JSON) metadata overlay** mapping FQN→class: drifts from the code, pollutes the language-agnostic metadata with per-language class paths, and is only validated at runtime.

Industry precedent (cross-language schema tools): **Protobuf** uses a `TypeRegistry` keyed by FQN/type-URL, populated by **generated code in each `.proto`'s output that self-registers** (`proto.RegisterType`, etc.). **gRPC** emits **per-service** registration that composes at startup. **Jackson** prefers explicit `@JsonSubTypes` over reflection scanning. **class-transformer** (TS) requires explicit discriminator maps because TS has no reflection. **SQLAlchemy** centers a `registry` construct that declarative and imperative mapping both populate.

## Decision

**Resolve the binding at build/codegen time, in generated code — never via runtime reflection.** The binding is keyed by the canonical metadata FQN and is **domain-sliced and composable** (each codegen unit contributes its own bindings; the runtime aggregates them). The realization is idiomatic per language paradigm:

| Paradigm | Realization | Discovery / composition |
|---|---|---|
| **Data-oriented** (TS) | generated **static imports** (convention: namespace→file path) + lookup by name in the loaded metadata tree; **no registry object** (codegen emits plain types + schemas, not OO classes) | barrel re-export; the metadata tree *is* the runtime registry |
| **OO** (Java / C# / Python) | generated, **domain-sliced registration** into an **FQN-keyed runtime registry** (typed objects are instantiated, so build-time static imports alone can't provide runtime polymorphic instantiation) | **Java:** one `MetaDataTypeProvider` **per generated package**, auto-discovered + merged via `ServiceLoader`. **C#:** source-generated registration per assembly via a module initializer (AOT-safe). **Python:** per-package registration at import / entry-points. |

The **durable contract** (conformance-describable) is: *the binding key is the metadata FQN, it is established in generated code at build time, and it is composable across independently-generated slices.* The **realization is idiomatic** per language (matching the project's "durable contract identical; runtime surface idiomatic" rule).

The language-agnostic metadata holds **no** native class paths. Any one-off divergence from convention is expressed as an inline `@object` attribute on a single MetaObject — never a whole overlay file.

## Consequences

**Positive**
- Compile/type-checked in TS/Java/C# (rename a class → the generated registration won't compile); import-checked in Python. Drift caught at build, not runtime.
- **AOT / native-image safe** (no runtime reflection-by-name).
- **Domain-sliced & composable** — multi-package/multi-jar codegen each contributes a registration unit; the runtime composes them (Java `ServiceLoader` is purpose-built for exactly this; it already loads core's type providers).
- Metadata stays language-agnostic; no driftable overlay.
- Matches what the TS port already ships (this ADR validates and generalizes existing behavior, it does not re-architect it).

**Negative / costs**
- OO ports emit one small registration unit per codegen slice (a generated artifact). This is folded into the per-target codegen output already produced, and is the same model protobuf/gRPC use, so the cost is minimal and idiomatic.
- The runtime needs a registry abstraction + a discovery hook per language (a one-time investment per port).

## Alternatives considered (rejected)
1. **Runtime reflection / convention-by-name** — impossible in TS; AOT/native-image-hostile in Java/C#. Rejected as a *universal* mechanism (it remains available only as a per-language optimization where reflection is acceptable).
2. **Single global registry** — can't be assembled from independently-generated package slices.
3. **Generated/maintained metadata overlay (FQN→class JSON)** — driftable, runtime-only checking, pollutes language-agnostic metadata.

## Realization status
- **TS** — shipped (data-oriented: static imports + metadata-tree lookup; no registry object needed).
- **Java** — in the OMDB persistence work: per-package `MetaDataTypeProvider` registry via `ServiceLoader`, consulted by ObjectManagerDB to instantiate entities and typed jsonb value-objects.
- **C#** — future runtime work: source-generated registration per assembly.
- **Python** — post-H3.

## Conformance note
Runtime instantiation APIs are out of byte-identical conformance scope (per `spec/conformance-tests.md` — runtime surface is idiomatic). What is conformance-relevant is the **key**: the canonical FQN form (`pkg::Name`) used as the registry key, which the loader/serializer corpus already pins.
