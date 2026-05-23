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
- **Java** — register `object.entity`/`object.value`, **retire `pojo`/`proxy`/`mapped` as subtypes**, retire `@javaRuntime`. The *defaulting realization* in Decision §2.i–§3 (a per-node resolver that picks a `Pojo`/`Proxy`/`Map` representation **class** from the binding) was **superseded** during implementation — see the **Amendment (2026-05-23)** below and `docs/superpowers/specs/2026-05-23-java-object-representation-redesign-design.md`. Java realizes representation as two semantic classes (`EntityMetaObject`/`ValueMetaObject`) carrying a built-in reflection/map hybrid dispatched on the **live object**, plus an optional **Java-only** `@objectAdapter` FQN hook for custom representations (e.g. proxy).
- **C#** — adopt: ensure `object.entity`/`object.value`; **delete the `@javaRuntime` definitions** (`ObjectConstants`/`CoreAttrSchemas`/`MetaObject`); resolver-based representation. *(A separate C# session is pointed at this ADR.)*
- **Python** — adopt: `entity`/`value` + resolver; never introduce `@javaRuntime`. *(A separate Python session is pointed at this ADR.)*

## Conformance note
The subtype names `entity`/`value` and their casing are **conformance-pinned** (canonical serialization). Representation *resolution* is runtime/idiomatic — out of byte-identical scope per `spec/conformance-tests.md`. The one hard cross-language assertion: **no representation attribute (`@javaRuntime`, `@objectAdapter`, or any `@<lang>Runtime`/`@representation`) must ever appear in canonical output** in any port. `@objectAdapter` (Java) is a non-portable runtime hint and is never added to the shared conformance corpus.

## Amendment (2026-05-23) — Java realization supersedes the "resolver picks a representation class" default

The cross-language **principles** of this ADR stand unchanged: the object subtype is **semantic only** (`entity`/`value`); **no portable representation attribute** ever enters the standard or the conformance corpus. What is amended is the Java *realization* of Decision §2.i–§3.

**Why.** Implementing the per-node resolver (precedence `@object` → registry → default; *concrete class → reflection, interface → proxy, unbound → Map*) against the full Java codebase exposed two flaws: (a) `object.value` already existed as a representation subtype in a downstream module, colliding with the new registration; and (b) the "**bound concrete class → reflection**" default is simply wrong when the bound class is itself **map-backed** (the Java `ValueObject`) — the resolver chose reflection and runtime calls failed (`NoSuchMethodError`). Representation is a property of the **live object**, not the declared class, and the resolver also could not see the downstream representation classes (module direction). See the redesign spec for the full diagnosis.

**Java's realization instead:**
- Two concrete classes — `EntityMetaObject` (`object.entity`) and `ValueMetaObject` (`object.value`) — share **one built-in hybrid**: value access dispatches on the live object (`ValueObject`/`Map` → map access; otherwise reflection on a bound POJO), and `newInstance` instantiates the bound class when one is bound, else a `ValueObject`. This is robust by construction (no class-vs-reflection mismatch) and needs **no attribute** in the common case.
- A single, deliberately un-sophisticated extension seam: the **Java-only**, optional `@objectAdapter="<FQN>"` attribute names a class implementing a 3-method `ObjectAdapter` interface, instantiated and delegated to. **No registry / no ServiceLoader.** It is the narrow, FQN-based, never-required successor to the retired `@javaRuntime`, and is **non-portable** (other ports ignore it; never in conformance).
- `pojo`/`proxy`/`map`/`data`/`managed` representation classes are deleted; **proxy** is demoted to a reference `ObjectAdapter` example, not a built-in.

**Scope of the amendment.** This is a Java realization detail. C#/Python (if/when they instantiate objects) may keep the simpler resolver default from §3 *or* adopt a hybrid — the `@objectAdapter` hook is Java-specific sophistication other ports need not replicate. The portable contract (semantic `entity`/`value`; no portable representation attribute) binds all ports identically.
