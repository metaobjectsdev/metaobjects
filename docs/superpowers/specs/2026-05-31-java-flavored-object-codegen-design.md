# Java Flavored Object + Extractor Codegen — Design

_Date: 2026-05-31. Status: approved (design). **Java only** — TS/Python/C#/Kotlin frozen until Java is correct. Builds on Phase A (runtime object model) + Phase B (metadata-driven recover)._

## Problem & goal

Generating objects that contain sub-objects (single instances and arrays-of-objects) partially exists today — `codegen-spring`'s `SpringPayloadGenerator` emits nested **Java records** (the prompt-payload wire shape). The goal is a **general-purpose** flavored object generator, usable for entities, prompt-request VOs, and extraction-target VOs alike, that emits objects in **selectable flavors** plus a **dedicated extractor**:

- **`pojoAware`** — a mutable POJO that `extends` a `MetaObjectAware` base (so the instance carries its `MetaObject`).
- **`valueObject`** — a class using the map-backed, extensible `ValueObject` as its base (typed accessors over the map; carries metadata-declared values beyond the typed fields).
- a generated **`<Name>Extractor`** class that performs the extraction (recover) into the flavored object.

The flavor is a **generator config option** (not a metadata attribute) — the same metadata emits any flavor. Generation is **direct code-as-code emission** (StringBuilder/writer appending source), **not templates** — the fast approach used in the legacy reference implementation and already used by this repo's `SpringPayloadGenerator`/`SpringOutputParserGenerator`/`BaseObjectCodeGenerator`. The Mustache `basic-pojo` template lane is explicitly NOT used.

## Foundation already in place (this repo)

- **Runtime (Phase A):** `MetaObjectAware` (instance→MetaObject back-ref), `ValueObject` (map-backed + extensible), `ObjectClassRegistry` + `ObjectClassBindingProvider` (self-registering FQN→class), `MetaObject.newInstance()`, `MetaField` get/set-by-name SPI (POJO via the reflective setter path `retrieveSetterMethod`; `ValueObject` via the map).
- **Runtime (Phase B):** `MetaObjectRecover.recover(MetaObject, text[, format[, opts]]) → RecoveryResult<Object>` (in `om`) — assembles a typed object graph (nested + arrays) via `newInstance` + the field SPI; never-throws + `orThrow`; cycle/depth guard.
- **Codegen home:** `codegen-base/.../generator/direct/object/` has `BaseObjectCodeGenerator extends MultiFileDirectGeneratorBase<MetaObject>` + `BaseObjectCodeWriter` + a `javacode` subpackage — the language-agnostic **direct** object-codegen base. The flavored Java generator lives here.
- **Record flavor:** `SpringPayloadGenerator` already emits nested-capable records (the Jackson-wire payload). It stays for that use; the new generator adds the two runtime-metadata-aware flavors.

## Missing piece (to add)

- **`PojoObject`** base — absent in this repo. Port the legacy `abstract class PojoObject implements MetaObjectAware` (holds the `MetaObject`, ctor takes it), **fixing the legacy `setMetaData` self-assignment bug** (`metaObject = metaObject` → `this.metaObject = metaObject`, and make the field non-final or drop final to allow `setMetaData`). Place in `metadata/.../object/pojo/PojoObject.java`. (Optionally implement `Validatable` only if that interface exists in this repo; otherwise just `MetaObjectAware`.)

## Design

### Runtime base class
`PojoObject` (new) — flavor `pojoAware`'s base. Generated POJOs `extends PojoObject`, calling `super(mo)` to set the back-ref.

### Object generator (direct, in `codegen-base/.../direct/object/javacode/`)
A Java object generator built on `BaseObjectCodeGenerator`/`BaseObjectCodeWriter`, with a **`flavor`** config option ∈ `{ pojoAware, valueObject }`. Direct emission (the writer appends source — no templates). For each `object.*` MetaObject:

- **`pojoAware`** → `public class <Name> extends PojoObject`:
  - typed fields for every `MetaField`: scalars/enums mapped to Java types; a nested `field.object` (`@objectRef`) → the nested class type `<Sub>` (single) or `java.util.List<<Sub>>` (when `isArrayType()`), the nested class generated recursively in the same flavor (deduped per run);
  - standard getters/setters; a `public <Name>(MetaObject mo){ super(mo); }` ctor (+ a no-arg ctor if needed by the field-IO reflective path);
  - field write/read at runtime uses the existing Phase A reflective setter/getter path.
- **`valueObject`** → `public class <Name> extends ValueObject` — **structurally different from `pojoAware`, and performance-tuned**:
  - `public <Name>(MetaObject mo){ super(mo); }`;
  - **NOT** naive `get(name)`/`set(name, v)` per call. Each field's **value-holder is cached once** (at construction) and the typed `getX`/`setX` operate on the cached holder directly (`holder.getValue()` / `holder.setValue(v)`), avoiding a keyed map lookup on every accessor call. This is the perf pattern the legacy reference uses.
  - the backing map carries everything, so metadata-declared values beyond the typed accessors are retained (extensible);
  - nested accessors typed `<Sub>`/`List<<Sub>>`.

  **Reference + a likely runtime reconciliation:** the perf-tuned holder pattern is in the legacy reference's data/managed object bases — a `Map<String, Value>` where `Value` is a per-field holder exposing `getValue()`/`setValue()`, so a cached holder reference services get/set without re-hashing (the legacy `ManagedObject`/`DataObjectBase` + this repo's `ValueObjectBase.AttributeEntry`). This repo's `ValueObjectBase` currently exposes `AttributeEntry` but may re-look-up by name; the plan must **study the legacy reference and reconcile `ValueObjectBase` to expose a cached per-field value-holder primitive** (e.g. `valueHolder(name)` returning a stable holder) that the generated accessors cache + use directly. The `pojoAware` flavor needs no such primitive (plain typed fields).
- Both flavors emit a **self-registering `ObjectClassBindingProvider`** (FQN→generated class) — wired via ServiceLoader — so `MetaObject.newInstance()` / extract yield the generated type for that object's FQN.

### Dedicated `Extractor` generator (direct)
`public final class <Name>Extractor` with `public static ExtractionResult<<Name>> extract(MetaDataLoader loader, String text)` (+ an `opts` overload, and a `Format` parameter or sensible default): bakes the payload FQN, resolves the `MetaObject` via `loader.getMetaObjectByName(fqn)`, calls `MetaObjectRecover.recover(mo, text, …)`; because `<Name>` is registered, `newInstance` yields it and `assemble` populates it (nested + arrays recurse). Returns the typed result; never throws; `orThrow` available. (The generator emits `MetaObjectRecover` by FQN string — `codegen-base` needs no `om` compile dep; the test needs `om`.)

### Nested sub-objects
Single + array handled by recursive generation (each nested VO → its own flavored class + provider) + the Phase B runtime `assemble` recursing. A per-run dedupe set prevents re-emitting a shared nested type; a cycle guard (visited-set / `MAX_NEST_DEPTH`) bounds self-referential graphs, falling back to a non-recursive reference.

## Relationship to the existing record payload generator

The `record` payload output (`SpringPayloadGenerator`) is the immutable Jackson-wire shape for the prompt pillar and **stays as-is**. The new generator adds the two **runtime-metadata-aware** flavors for general/entity/extraction use (mutable, MetaObject-bearing, registry-bound). They coexist (different use cases); unifying all three under one `flavor` option is a possible later cleanup, not this scope.

## Testing (Java only)

Direct compile-and-run proofs (the gold-standard gate, like the FR-010/Phase-B codegen proofs):
- For each flavor, generate an object with a nested sub-object + an array-of-objects, compile in-memory (javac), and assert: the class extends the right base; `newInstance` yields it with the `MetaObject` back-ref set; the generated `Extractor.extract(loader, dirtyText)` populates the nested object + array-of-objects (not null) into the flavored instance; `pojoAware` fields set via getters, `valueObject` values present via the map + typed accessors.
- A self-registration test: the generated provider registers the FQN→class, so `MetaObject.newInstance()` returns the flavored type.

(No cross-port conformance corpus yet — other ports are frozen. A Java conformance fixture can seed a future cross-port corpus once Java is correct.)

## Out of scope (explicit)

- **All other ports** (TS/Python/C#/Kotlin) — frozen until Java is correct.
- **Templates** — generation is direct code-as-code only.
- Changing the existing `record` payload generator.
- Strict-`parse()`/DDL consumption of these flavors; the `recover→extract` rename (queued separately).
