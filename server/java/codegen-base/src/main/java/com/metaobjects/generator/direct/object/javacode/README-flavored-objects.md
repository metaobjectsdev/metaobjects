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

The Extractors have a generator of their own as well, `ExtractorCodeGenerator`, wirable as
a separate `<generator>` with the same `outputDir` and naming args. When one is in the run
`JavaObjectCodeGenerator` leaves the files to it (`emitExtractors=false`, which the Maven
plugin sets from the generator list; `EmitsObjectExtractors` is the marker it reads).

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

## Owning the generators (`mvn metaobjects:eject`)

`JavaObjectCodeGenerator` (`entity`) and `ExtractorCodeGenerator` (`extractor`) eject into
the adopter's `codegen/` module, each with the rest of its emit (ADR-0034 Amendment 6).
This module's pom ships the sources under `META-INF/metaobjects/reference/java/`, and
`GeneratorRegistry` (in `codegen-spring`) declares which classes go with which generator.

| Generator | Copied with it, into the same owned package |
|---|---|
| `entity` | `JavaCodeGenerator`, `BaseObjectCodeGenerator`, `BaseObjectCodeWriter`, `JavaCodeWriter`, `PojoAwareCodeWriter`, `ValueObjectCodeWriter` |
| `extractor` | `JavaCodeWriter`, `BaseObjectCodeWriter` |

Eject rewrites each file's package line and, where one copied class imports another, that
import. So the owned generator extends and calls the owned copies: an adopter changes the
class body by editing a writer, not by subclassing one. What a copy may still rely on in
this module, and so what has to keep working for it:

- `MultiFileDirectGeneratorBase` and `FileDirectWriter`, which the copies extend;
- `GenerationContext`, `GeneratorUtil`, `JavaIdentifiers` and `GeneratedFileWriter`;
- `ExtractorCodeGenerator.emit(...)`, which an owned `entity` calls until an `extractor`
  generator is wired beside it.

Two rules keep a copy set ejectable, and `EjectedBaseGeneratorsCompileTest` fails when
either is broken. A class in a copy set may name another class of this package by its bare
name only if that class is in the same set; anything else (the owned `entity` naming
`ExtractorCodeGenerator`) is imported explicitly. And a copied class calls nothing that is
not `public` on a class left behind. A new class the writers come to depend on is added to
the set in three places: this module's pom, `GeneratorRegistry`, and that test.

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
6. **Class header (changed).** `BaseObjectCodeWriter` no longer writes the
   `ObjectCodeWriter:` and `Generated On:` header lines. Generated output holds nothing
   that varies between runs or between a packaged writer and an owned copy of it.

## Status / known gaps

- Java only. Other ports (TS/Python/C#/Kotlin) are out of scope for this feature.
- The `extract`/`extract` method names track the runtime `MetaObjectExtractor`/`ExtractionResult`
  naming; the queued cross-port `extract → extract` rename will sweep both.
