# ADR-0005 — Object representation: `entity`/`value` semantics + binding-resolved representation (OO ports)

**Status:** Accepted — 2026-05-23
**Applies to:** all object-instantiating ("OO") ports — Java, C#, Python (TS is data-oriented; see *Realization status*)
**Builds on:** [ADR-0001](ADR-0001-cross-language-type-binding.md) (the FQN→class binding mechanism); relates to [ADR-0002](ADR-0002-open-closed-typed-nodes.md), [ADR-0004](ADR-0004-provider-based-type-registration.md); `spec/metamodel.md`; `spec/conformance-tests.md`.

## Context

An `object` in the metamodel has a **semantic role**: `object.entity` (a persistent record with identity) or `object.value` (a value object, equality by content) — plus the abstract `object.base`. These three subtypes are the cross-language vocabulary (`spec/metamodel.md`).

OO ports must, at runtime, instantiate a **concrete representation** for an object — reflection over a generated class, a Map/dictionary-backed container, or an interface proxy. The question this ADR settles: **how is that representation chosen, without polluting the language-agnostic metadata with language-specific concepts?**

Two approaches were tried and are rejected here, having caused real divergence:

- **Representation-as-subtype.** The Java port registered `object.pojo` / `object.proxy` / `object.mapped` as *subtypes*, conflating the semantic role with the language representation. This diverges from the standard's `entity`/`value` vocabulary — a non-conformance.
- **A portable `@javaRuntime` attribute** (`"pojo" | "map" | "proxy"`). Found *defined* in the C# port (`ObjectConstants`/`CoreAttrSchemas`/`MetaObject`), present only in TS *test fixtures*, **absent** in Python, **unused** by Java (which used subtypes), and **not** in the shared conformance corpus. A language-specific (Java) concept baked into the portable vocabulary that most ports carry but don't use — pure cruft.

[ADR-0001](ADR-0001-cross-language-type-binding.md) already establishes the durable binding mechanism: the binding key is the metadata FQN, resolved in generated code at build time (never runtime reflection-by-name), composable across slices — and it sanctions an inline `@object` attribute as the one-off divergence-from-convention. This ADR layers the *object-representation* policy on top of that mechanism.

## Decision

1. **The object subtype is semantic only — `entity` or `value`** (+ abstract `base`). It encodes identity/equality/codegen semantics, **never** the language representation.
2. **Representation is *resolved*, never declared as a portable attribute.** The resolution precedence for OO ports is:
   1. an **`@object` inline override** (ADR-0001's sanctioned one-off — e.g. a class FQN or a port-understood keyword);
   2. the **FQN→class binding registry** (ADR-0001, idiomatic per port);
   3. a **default** (next point).
3. **Defaulting principle (identical across OO ports):** when a concrete class is bound (via `@object` or the registry) → a **reflection/class-backed** representation (a bound *interface* → a **proxy**); when **unbound** → a **content/Map-backed value-object** representation (reflection needs a class; Map works without one). `entity` vs `value` does **not** switch the representation mechanism — the semantic role drives identity/equality and codegen, not which container class backs the node.
4. **No portable representation attribute.** `@javaRuntime` — and any `@<lang>Runtime`/`@representation` portable attr — is **retired** from every port and never enters the standard or the conformance corpus.
5. **Realization is idiomatic per port** (the project's "durable contract identical; runtime surface idiomatic" rule): the *resolution policy + the entity/value vocabulary* are the durable contract; the *concrete representation classes and discovery mechanism* are idiomatic.

## Consequences

**Positive**
- Metadata stays **language-agnostic** — `entity`/`value` only, no language-ism in the shared vocabulary; conformant canonical output.
- Representation is a **build/runtime concern resolved via ADR-0001's binding** — AOT/native-image-safe, consistent with the existing binding contract.
- The `entity`/`value` vocabulary is **identical across languages**; `@javaRuntime` cruft is removed everywhere.
- A port can run **without any class bound** (Map-backed default) — dynamic/runtime-only metadata still works.

**Negative / costs**
- Ports that encoded representation as a subtype (Java) or a portable attribute (C#) must **refactor** to resolve representation instead of reading it off the subtype/attr. The resolver + default is a one-time per-port investment.

## Alternatives considered (rejected)
1. **Representation-as-subtype** (`object.pojo`) — conflates semantic role with representation; non-conformant with `entity`/`value`.
2. **Portable `@javaRuntime`/`@representation` attribute** — a language-ism in the shared vocabulary; every port must round-trip a concept it may not use.
3. **Mandatory explicit representation on every object** — verbose; the binding + default already determine it, with `@object` as the escape hatch.

## Realization status
- **TS** — data-oriented (no OO instantiation: static imports + metadata-tree lookup). `entity`/`value` already correct. Action: remove the stray `@javaRuntime` from its test fixtures.
- **Java** — adopted by `docs/superpowers/specs/2026-05-23-java-standard-alignment-and-loader-consolidation-design.md`: register `object.entity`/`object.value`, **retire `pojo`/`proxy`/`mapped` as subtypes** (keep `PojoMetaObject`/`MappedMetaObject`/`ProxyMetaObject` as resolver-selected representation implementations), retire `@javaRuntime`.
- **C#** — adopt: ensure `object.entity`/`object.value`; **delete the `@javaRuntime` definitions** (`ObjectConstants`/`CoreAttrSchemas`/`MetaObject`); resolver-based representation. *(A separate C# session is pointed at this ADR.)*
- **Python** — adopt: `entity`/`value` + resolver; never introduce `@javaRuntime`. *(A separate Python session is pointed at this ADR.)*

## Conformance note
The subtype names `entity`/`value` and their casing are **conformance-pinned** (canonical serialization). Representation *resolution* is runtime/idiomatic — out of byte-identical scope per `spec/conformance-tests.md`. The one hard cross-language assertion: **`@javaRuntime` (or any representation attribute) must never appear in canonical output** in any port.
