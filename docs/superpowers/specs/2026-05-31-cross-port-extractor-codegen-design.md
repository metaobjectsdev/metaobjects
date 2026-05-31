# Cross-Port Extractor Codegen — Design

_Date: 2026-05-31. Status: approved (design). Ports: TS, Python, C#, Kotlin (Java already shipped). Precedes the queued `recover → extract` rename (#87)._

## Problem & goal

Java shipped a "flavored object + extractor codegen" feature: it generates objects that carry their `MetaObject` and a dedicated `<Name>Extractor` that recovers a typed nested object graph (nested objects + arrays-of-objects) from dirty LLM text. We want **capability parity** in the other four ports — every port should be able to codegen a dedicated `<Name>Extractor` that recovers a typed nested graph into the port's **idiomatic** object type — ahead of the cross-port `recover → extract` rename.

**Parity means capability, not symbols.** Each port uses its natural object shape (TS inferred type, Python Pydantic model, C# `record`/`class`, Kotlin `data class`). The two-flavor concept (`pojoAware`/`valueObject`) and the runtime binding registry stay **Java-only** — they are not needed for codegen'd extraction (see "Why no registry").

## Foundation already in place (all ports)

- **Phase A** — runtime object model: `ValueObject` (map-backed default), `MetaObjectAware`, `ObjectClassRegistry` + `newInstance()`, field get/set-by-name SPI (ADR-0017).
- **Phase B** — runtime `recover(MetaObject, text)` assembles a typed graph (nested + arrays) via `newInstance` + the field SPI; never-throws + `orThrow`; cycle/depth guard. Adds array-of-enum + generalized `@default`.
- **FR-010 / FR-011** — the **recover engine** (parse + coerce + classify + tolerant recovery), the metadata-derived **`RecoverSchema`** emitter, and per-port codegen of:
  - `parse<Name>(text) → <Name>Payload` (strict, throws)
  - `recover<Name>(text) → Result<<Name>Recovered>` (tolerant, never-throws; `<Name>Recovered` is an all-nullable mirror).
- Per-port **object/payload codegen** already emits the idiomatic target types (TS Zod-inferred / interfaces; Python Pydantic; C# record/class; Kotlin `@Serializable data class`).

## Why no registry (the key architectural decision)

Two distinct concerns were initially conflated:

1. **Figuring out the shape** — pure metadata traversal. Walk the `MetaObject`'s `MetaField`s: each gives the field name, type, enum-ness, nested `@objectRef` (single or array), and default. That is how recover already knows what to pull from the parsed text and how to coerce it. **No registry involved.**
2. **Resolving an FQN → native class at runtime** — the `ObjectClassRegistry`'s only job. It matters only when something holds a `MetaObject` at runtime and wants a native instance *without compile-time knowledge of the type* (a generic deserializer, a dynamic admin UI, OMDB). The default answer there is just `ValueObject` (a metadata-aware map) — still no registry required.

A generated `<Name>Extractor` is code-generated **for `<Name>`** — codegen already knows the entire concrete type graph statically (`<Name>`, its nested types, its array element types). So it **constructs them directly** (recursing into the nested types it also generated), guided by the metadata-derived schema. It never asks a registry "what class is this FQN" — it already knows. Direct construction calls the real constructor, so **immutable idiomatic types work for free** (`Model(**data)` for frozen Pydantic, a C# `record`, a Kotlin `data class`), matching the dominant structured-extraction pattern (Instructor/Pydantic construct-from-dict, never post-construct mutation).

Java routed its Extractor through the registry as a **reuse choice** (delegate to the runtime assembler instead of duplicating the recursive walk), not a necessity. The ports take the simpler path: **metadata traversal + direct construction, no registry, no binding provider, no factory.**

| Path | Needs a registry? |
|---|---|
| `recover(MetaObject, text)` → `ValueObject` graph (pure metadata traversal, no codegen) | No — already shipped |
| Generic runtime "give me the native type for this MetaObject" (dynamic UI, OMDB) | Yes — but that is not extraction |
| Generated `<Name>Extractor.extract(text)` → typed native object | **No — codegen knows the types, constructs directly** |

## Design

### The Extractor contract (per port)

Two methods, mirroring Java:

- **`extract(text) → <Name>`** — the real idiomatic type, fields typed per their metadata nullability (required non-null, optional nullable). **Throws** if a required field was lost. The strongly-typed payoff.
- **`recover(text) → Result<<Name>Recovered>`** — never-throws; the existing all-nullable mirror + report, repackaged into the Extractor.

`extract` runs the tolerant recover internally and, when nothing required is lost, constructs the clean `<Name>` from the recovered values; otherwise it throws (with the report). `recover` returns the never-throws result unchanged in shape from today's per-port `recover<Name>`.

### Direct construction + nested recursion

The Extractor walks the metadata-derived `RecoverSchema` (already emitted) to obtain coerced values, then constructs the idiomatic type in one shot. For a nested `@objectRef`:
- **single** → construct the nested type from its own recovered sub-map (recurse);
- **array** (`isArray`) → construct each element type and collect into the idiomatic list/sequence.

Codegen emits the construction for the whole statically-known graph. A self-referential graph is bounded by the same depth/cycle guard the recover engine already applies (`MAX_NEST_DEPTH`).

### Per-port idiomatic shape & packaging

| Port | Target type (already generated) | Extractor packaging | One-shot construct |
|---|---|---|---|
| **TS** | inferred type from the Zod schema / payload interface | `extract<Name>(text)` + `recover<Name>(text)` module functions (tree-shake friendly) | object literal |
| **Python** | Pydantic `BaseModel` (entity/payload) | `class <Name>Extractor` with `extract`/`recover` (classmethods or module fns) | `Model(**data)` / `model_validate` |
| **C#** | `record` / `class` (payload/entity) | `static class <Name>Extractor { Extract / Recover }` | `new <Name> { ... }` / positional |
| **Kotlin** | `@Serializable data class` | `object <Name>Extractor { extract / recover }` | `<Name>(...)` primary ctor |

### Dependency: nested type-graph coverage

The Extractor needs every type in the nested graph to exist as a generated type. Where a port's existing object/payload generator does not emit a needed nested type, that coverage gap is closed (generate it) or documented per port — surfaced during planning. Payload generators (Python, Kotlin) already emit nested payloads; entity/object coverage and C#'s payload story are verified per port in the plan.

## Testing

- **Per-port compile-and-run proofs** (gold-standard gate, as in Java): generate the Extractor for a payload with a nested object + an array-of-objects; run `extract(dirtyText)` and assert the typed graph is populated (nested not null; array elements are the typed element type with fields set; back-reference/identity as the port's model implies); run `recover(cleanText)` and assert a never-throws result with no lost-required.
- **Cross-port value oracle:** reuse the existing `fixtures/recover-conformance/` inputs/expectations as the shared oracle — `extract` must produce the *same field values* recover already produces, in the clean typed shape. Typed-object assertions are per-port (not byte-identical across languages); the extracted **values** must match the shared corpus. Add the nested+array typed-graph scenarios there only if missing.

## Out of scope (explicit)

- **No `ObjectClassRegistry` / binding-provider / factory** work in any port (stays Java-only; not needed for codegen'd extraction).
- **No new "flavored object-class" generation** (no `pojoAware`/`valueObject` equivalents) — the Extractor constructs each port's existing idiomatic types directly.
- **The `recover → extract` rename (#87)** — ports use the current `extract`/`recover` names; the rename sweeps all 5 ports together afterward.
- **Publish** — deferred to explicit user confirm.
- Java — already shipped; unchanged here.

## Sequencing

All 4 ports in the existing worktree `worktree-cross-port-flavored-objects`, single branch → single merge. Ports are independent; order chosen in the plan (likely Python or TS first as the clearest, then the rest). Each port: Extractor generator → compile-and-run proof → value-oracle check → review → next.
