# Flavored object + extractor codegen (Java)

Direct (code-as-code, no templates) generation of objects that carry their `MetaObject`
and extract a typed object graph (nested objects + arrays-of-objects) from dirty LLM text.
General-purpose: usable for entities, prompt-request VOs, and extraction-target VOs alike.

Builds on the runtime object model (`MetaObjectAware`, `ValueObject`, `ObjectClassRegistry`,
`MetaObject.newInstance()`) and the runtime extract (`MetaObjectExtractor.extract` in `om`).

## Flavors (selected by a generator config option, not metadata)

The flavor is the generator argument `flavor` (`JavaObjectCodeGenerator.ARG_FLAVOR`). The
same metadata emits any flavor.

| `flavor`        | Base class                                  | Shape |
|-----------------|---------------------------------------------|-------|
| `pojoAware`     | `com.metaobjects.object.pojo.PojoObject`    | Mutable POJO with typed fields + getter/setter bodies; carries its `MetaObject`. |
| `valueObject`   | `com.metaobjects.object.value.ValueObject`  | Map-backed + extensible; **perf-tuned** — each field's value-holder is bound once and accessors read/write it directly (no per-call keyed lookup). |
| _(absent)_      | _(interface)_                               | Legacy `JavaCodeWriter` interface emission — unchanged. |

For each concrete flavor, the generator also emits, per object:
- a self-registering `ObjectClassBindingProvider` (one per run, FQN→class) + its
  `META-INF/services` registration, so `MetaObject.newInstance()` yields the generated
  type for that object's FQN;
- a `<Name>Extractor` with `static <Name> extract(MetaDataLoader, String)` (typed,
  `orThrow`) and `static ExtractionResult<<Name>> extractLenient(MetaDataLoader, String)`
  (never-throws), both wrapping the runtime `MetaObjectExtractor.extract`.

Abstract objects are skipped for both the binding entry and the Extractor (they cannot be
`newInstance()`-d — honors the abstract-codegen invariant: no instance artifacts for abstracts).

## Reuse of the legacy framework (byte-unchanged)

The legacy direct object-codegen framework — `BaseObjectCodeGenerator`,
`BaseObjectCodeWriter`, `JavaCodeGenerator`, `JavaCodeWriter` — is **reused as-is**
(byte-unchanged). All new behavior is added by **subclassing + overriding hooks**:

- `JavaObjectCodeGenerator extends JavaCodeGenerator` — overrides `createWriter` (selects
  the writer by `flavor`) and `execute` (emits the provider + Extractor after the standard
  multi-file loop).
- `PojoAwareCodeWriter` / `ValueObjectCodeWriter` `extends JavaCodeWriter` — override
  `writeObjectHeader` (the `extends <base>` clause), `writeObjectMethods` (fields + ctor),
  `writeGetter` / `writeSetter` (concrete bodies); reuse the inherited naming/type hooks
  (`getGetterMethodName`, `getClassName`, `getLanguageType`, …).

## Downstream extensibility

Every new emission step is `protected` and overridable, and `createWriter` is the writer
factory seam. A downstream project subclasses a writer (override a `protected` seam) and a
generator (override `createWriter` to return its writer). Proven by
`DownstreamCustomizationTest` (overrides `getGetterMethodName` → `fetch<Name>()` via a
`createWriter` override, compiled + asserted).

## Deviation list (what is NOT reused as-is, and why)

The default is reuse; these are the accounted-for exceptions.

1. **`ValueObjectBase.valueHolder(String)` (new, additive).** The existing `AttributeEntry`
   re-looks-up by name on every access (current, but not a bind-once perf accessor). Added
   a `valueHolder(name)` returning the stable cached `DataObjectBase.Value` cell that
   `get`/`set` already route through (memoized in the backing map) — the perf primitive the
   `valueObject` accessors bind once. Purely additive; `get`/`set`/`entrySet`/map semantics
   unchanged.
2. **`PojoObject` (new) fixes the legacy `setMetaData` self-assignment bug.** The legacy base
   self-assigned (`metaObject = metaObject`) and held the field `final`; here the field is
   mutable and `setMetaData` actually replaces the back-ref (regression-guarded by a test).
3. **`JavaObjectCodeGenerator.execute()` override emits resource files directly.** The frozen
   `MultiFileDirectGeneratorBase` writes one `.java` per object and has no generic
   resource-output mechanism, so the override writes the provider `.java` + the
   `META-INF/services` file via `Files.write` after `super.execute()`. No legacy change.
4. **`PojoAwareCodeWriter` emits an `Object`-typed bridge setter for single nested-object
   fields.** The runtime set-by-name SPI hands an `Object` for an `OBJECT` field, but the
   typed setter takes `<SubType>`; the bridge setter lets extract populate a single nested
   object. (Arrays need none — their effective value class is `List`.)
5. **Recursive nested emission is moot.** `@objectRef` always targets a top-level named
   `MetaObject` already in the loader, so the inherited flat multi-file loop emits every
   referenced sub-object exactly once — no visited-set/cycle guard needed (the spec's
   recursive-emission note is superseded by this simpler sound behavior).

## Status / known gaps

- Java only. Other ports (TS/Python/C#/Kotlin) are out of scope for this feature.
- The `extract`/`extract` method names track the runtime `MetaObjectExtractor`/`ExtractionResult`
  naming; the queued cross-port `extract → extract` rename will sweep both.
