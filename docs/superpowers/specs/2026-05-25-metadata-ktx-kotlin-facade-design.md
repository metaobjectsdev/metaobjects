# `metadata-ktx` — Kotlin facade over the Java MetaObjects engine

- **Date:** 2026-05-25
- **Status:** Design — plan-of-record. Re-affirmed from the locked 2026-05-23 brainstorm, with the template/render scope added now that Java FR-004 has shipped to main.
- **Target version:** 7.0.0-SNAPSHOT
- **Supersedes:** [metadata-ktx-facade-design memory](../../../.claude/projects/-home-doug-Development-metaobjects/memory/metadata-ktx-facade-design.md) (pinned PAUSED entry).

## 1. Goal

A thin idiomatic-Kotlin facade over the Java MetaObjects engine — covers metadata loading, READ navigation, and the FR-004 template + render + verify surface. Mirrors the shipped sibling `metaobjects-omdb-ktx`. **REUSE-AND-WRAP** only — no Java engine changes; no parallel API surface.

A Kotlin app consuming MetaObjects (load metadata, navigate it, render LLM prompts via `template.prompt`, drive omdb persistence) gets idiomatic Kotlin ergonomics without leaking Java patterns (Optional, raw enums, platform-nullable types, reflection-style field access).

## 2. Wrap-where-friction principle

**Wrap only where Kotlin interop leaves real friction.** Where Java works fine from Kotlin as-is, document the pattern in README + write a characterization test — don't add a wrapper.

| Friction source | Wrap? | Why |
|---|---|---|
| Java `Optional<T>` getters | YES | Idiomatic Kotlin is `T?` |
| Java platform-nullable types (`String!`) on key APIs | YES | Pin to explicit `T` or `T?` |
| Java raw `String` representing closed enums | YES | Typed nullable Kotlin enums (`Cardinality`, `IdentityGeneration`) |
| Class-token APIs (`getMetaField(name, Class<T>)`) | YES | `inline fun <reified T>` reads cleaner |
| Java factories returning loaders (`MetaDataLoader.fromDirectory/.../...`) | YES | Top-level Kotlin fns matching cross-language convention (TS/Python ship these too) |
| FR-004 render entry point (`new Renderer().render(...)`) | YES | Top-level `render(request)` + a Kotlin-friendly `RenderRequest` builder helper |
| FR-004 verify entry point | YES | Top-level `verify(template, fields, options)` shortcut |
| MetaObject/MetaField mutator methods | NO | Java mutators read fine from Kotlin |
| Custom MetaObject/MetaField subtypes | NO | `class MyType : EntityMetaObject(...)` works directly |
| Custom `Provider` / `MetaDataSource` impls | NO | `class MySource : Provider { ... }` works directly |
| MetaDataRegistry builder API (`registerType(cls, def -> ...)`) | NO | Already lambda-friendly; Kotlin lambdas just work |
| Java getters with no nullability annotation that already return non-null (e.g., `getName()`) | NO | Kotlin synthetic properties already cover them |

This is intentionally narrow. A new wrapper requires a real friction point with a written rationale — not "we could."

## 3. Module + Maven coords

- **Module path:** `server/java/metadata-ktx/`
- **Artifact:** `metaobjects-metadata-ktx`
- **Package:** `com.metaobjects.metadata.ktx`
- **Parent POM:** `com.metaobjects:metaobjects:7.0.0-SNAPSHOT` (same parent as omdb-ktx)
- **Kotlin version:** 2.0.21 (matches omdb-ktx)
- **JVM target:** 21 (matches omdb-ktx)
- **Test framework:** JUnit5 + `kotlin-test-junit5` (matches omdb-ktx)
- **Production dependencies:** `metaobjects-metadata`, `metaobjects-render`, `kotlin-stdlib`. **No omdb dep** — metadata-ktx sits below omdb-ktx in the stack.
- **Registration in `server/java/pom.xml`** `<modules>` after `metadata` (so metadata-ktx compiles before downstream consumers).

The omdb-ktx pom is the literal template — match its plugin block (kotlin-maven-plugin + kotlin-test-junit5 wiring), drop the omdb/derby deps, add `metaobjects-metadata` + `metaobjects-render`.

## 4. File layout

```
server/java/metadata-ktx/
├── pom.xml
├── README.md
└── src/
    ├── main/kotlin/com/metaobjects/metadata/ktx/
    │   ├── Loader.kt              # loadDirectory / loadUris / loadResources / loadString top-level fns
    │   ├── MetaObjects.kt         # metaObjectOrNull / promptTemplateOrNull / outputTemplateOrNull / templateOrNull
    │   ├── Fields.kt              # reified field<T>() + requireField<T>() + nullable typed enums
    │   ├── Attrs.kt               # attrOrNull / attrStringOrNull on MetaData
    │   ├── Identity.kt            # IdentityGeneration enum + generationStrategy ext prop
    │   ├── Relationships.kt       # Cardinality enum + cardinalityType ext prop + targetObjectOrNull
    │   └── Render.kt              # render(RenderRequest) + render { ... } builder + verify(...) shortcut
    └── test/kotlin/com/metaobjects/metadata/ktx/
        ├── LoaderTest.kt          # loadString/loadResources via the new top-level fns
        ├── MetaObjectsTest.kt     # null-on-missing + reified template subtype access
        ├── FieldsTest.kt          # field<T>() + requireField<T>() + cardinalityType + generationStrategy
        ├── AttrsTest.kt           # attrOrNull / attrStringOrNull edge cases
        ├── RenderTest.kt          # render { ... } builder + idiomatic call path
        └── README.kt              # compile-checked README code samples (matches omdb-ktx pattern)
```

7 source files, 6 test files. Total estimated ~600 LOC (mostly tests).

## 5. API surface — wrappers

### 5.1 `Loader.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import java.net.URI
import java.nio.file.Path

/** Load metadata from a filesystem directory. Cross-port convention name. */
fun loadDirectory(name: String, directory: Path): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory)

fun loadDirectory(name: String, directory: Path, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromDirectory(name, directory, opts)

/** Load metadata from a list of URIs. */
fun loadUris(name: String, uris: List<URI>): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris)

fun loadUris(name: String, uris: List<URI>, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromUris(name, uris, opts)

/** Load metadata from classpath resources. */
fun loadResources(name: String, resources: List<String>): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources)

fun loadResources(name: String, resources: List<String>, opts: LoaderOptions): MetaDataLoader =
    MetaDataLoader.fromResources(name, resources, opts)

/** Load metadata from a single inline string. */
fun loadString(name: String, content: String, format: MetaDataFormat = MetaDataFormat.JSON): MetaDataLoader =
    MetaDataLoader.fromString(name, content, format)
```

### 5.2 `MetaObjects.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaData
import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataLoaderRegistry
import com.metaobjects.object.MetaObject
import com.metaobjects.template.MetaTemplate
import com.metaobjects.template.OutputTemplate
import com.metaobjects.template.PromptTemplate

/** Lookup a MetaObject by name; returns null if not found. */
fun MetaDataLoader.metaObjectOrNull(name: String): MetaObject? =
    try { getMetaObjectByName(name) } catch (_: MetaDataNotFoundException) { null }

fun MetaDataLoaderRegistry.metaObjectOrNull(name: String): MetaObject? =
    try { getMetaObjectByName(name) } catch (_: MetaDataNotFoundException) { null }

/** Lookup a template by name (any subtype); returns null if not found OR not a template. */
fun MetaDataLoader.templateOrNull(name: String): MetaTemplate? =
    root.findChildByType("template", name) as? MetaTemplate

/** Lookup a template.prompt by name; returns null if not found OR not a prompt. */
fun MetaDataLoader.promptTemplateOrNull(name: String): PromptTemplate? =
    templateOrNull(name) as? PromptTemplate

/** Lookup a template.output by name; returns null if not found OR not output. */
fun MetaDataLoader.outputTemplateOrNull(name: String): OutputTemplate? =
    templateOrNull(name) as? OutputTemplate
```

(Method names — `getMetaObjectByName`, `findChildByType` — are placeholders; verify exact API in the implementation plan.)

### 5.3 `Fields.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.field.MetaField
import com.metaobjects.object.MetaObject

/** Lookup a typed field by name; returns null if absent OR wrong subtype. */
inline fun <reified T : MetaField> MetaObject.field(name: String): T? =
    runCatching { getMetaField(name) }.getOrNull() as? T

/** Lookup a typed field by name; throws if absent. Returns null if wrong subtype. */
inline fun <reified T : MetaField> MetaObject.requireField(name: String): T =
    getMetaField(name) as T

/** Return all fields matching the requested subtype. */
inline fun <reified T : MetaField> MetaObject.fieldsOfType(): List<T> =
    metaFields.filterIsInstance<T>()
```

### 5.4 `Attrs.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaData
import com.metaobjects.attr.MetaAttribute

/** Read an own-only attribute as MetaAttribute; null if absent. */
fun MetaData.attrOrNull(name: String): MetaAttribute? =
    if (hasMetaAttr(name, false)) getMetaAttr(name, false) as MetaAttribute else null

/** Read an own-only attribute as String; null if absent or not string-valued. */
fun MetaData.attrStringOrNull(name: String): String? =
    attrOrNull(name)?.valueAsString
```

### 5.5 `Identity.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.identity.MetaIdentity

enum class IdentityGeneration { INCREMENT, UUID, ASSIGNED }

/** Typed nullable enum for @generation; null on absent/unknown. */
val MetaIdentity.generationStrategy: IdentityGeneration?
    get() = when (generation?.lowercase()) {
        "increment" -> IdentityGeneration.INCREMENT
        "uuid" -> IdentityGeneration.UUID
        "assigned" -> IdentityGeneration.ASSIGNED
        else -> null
    }
```

### 5.6 `Relationships.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.MetaDataNotFoundException
import com.metaobjects.object.MetaObject
import com.metaobjects.relationship.MetaRelationship

enum class Cardinality { ONE, MANY }

/** Typed nullable enum for cardinality; null on absent/unknown. */
val MetaRelationship.cardinalityType: Cardinality?
    get() = when (cardinality?.lowercase()) {
        "one" -> Cardinality.ONE
        "many" -> Cardinality.MANY
        else -> null
    }

/** Resolve targetObject to nullable MetaObject; null if unresolved or not found. */
val MetaRelationship.targetObjectOrNull: MetaObject?
    get() = try { targetObject } catch (_: MetaDataNotFoundException) { null }
```

### 5.7 `Render.kt`

```kotlin
package com.metaobjects.metadata.ktx

import com.metaobjects.render.PayloadField
import com.metaobjects.render.Provider
import com.metaobjects.render.RenderRequest
import com.metaobjects.render.Renderer
import com.metaobjects.render.Verify
import com.metaobjects.render.VerifyError
import com.metaobjects.render.VerifyOptions

/** Render via an explicit Java RenderRequest record. */
fun render(request: RenderRequest): String =
    Renderer().render(request)

/** Render via a Kotlin builder — assigns required fields by reference + provides defaults. */
class RenderBuilder {
    var template: String? = null
    var ref: String? = null
    var payload: Any? = null
    var provider: Provider? = null
    var format: String = "text"
    var verify: List<PayloadField>? = null
    var maxChars: Int? = null

    fun build(): RenderRequest = RenderRequest(
        template, ref, payload, provider, format, verify, maxChars
    )
}

inline fun render(block: RenderBuilder.() -> Unit): String =
    render(RenderBuilder().apply(block).build())

/** Verify shortcut wrapping Verify.check(...). */
fun verify(
    templateText: String,
    fields: List<PayloadField>,
    options: VerifyOptions = VerifyOptions.empty()
): List<VerifyError> = Verify.check(templateText, fields, options)
```

The `render { ... }` builder is the ONE small concession to DSL ergonomics — it's a flat property-bag builder, NOT a nested DSL with sub-blocks. The user has approved this scope.

## 6. Cross-port classification

### Tier 1 — invariant (must match cross-port semantics)

- Loader factory names map to the cross-port convention: `loadDirectory`, `loadUris`, `loadResources`, `loadString` (parallel to TS module-level shortcuts + Python class methods, with appropriate per-language casing).
- Template subtypes navigated via Kotlin functions still respect the Tier-1 metatype vocabulary (`template.prompt` / `template.output`).
- Render entry semantics: same `RenderRequest` shape (template/ref/payload/provider/format/verify/maxChars) as Java/C#/TS.

### Tier 2 — idiomatic per-port

- Kotlin extension functions instead of wrapper classes (Java port style; matches omdb-ktx).
- `T?` instead of `Optional<T>`.
- Typed nullable enums (`Cardinality`, `IdentityGeneration`) instead of raw strings.
- `inline reified` typed accessors instead of `Class<T>` parameters.
- The `render { ... }` Kotlin builder is a Kotlin-only convenience; not a cross-port API.

### Tier 3 — internal / free

- Whether typed-enum lookups use `when` expressions or a Map (`when` is the simpler default).
- Whether nullability-pinning extensions live in one file or are split per type (we split per type for clarity).

## 7. Testing strategy

- **Unit tests per file** (5–10 each) — exercise each wrapper.
- **`README.kt`** compile-checked code samples — every example in the README must compile in this test file. Matches `omdb-ktx`'s pattern.
- **Integration smoke** — load a small `meta.*.json` test fixture from classpath via `loadResources()`, navigate it with the typed wrappers, render a template.prompt via `render { ... }`, verify the rendered output.
- **No conformance corpus needed** — this is a wrapper, not a metamodel implementation. The Java engine's conformance is the source of truth.

## 8. Out of scope

- **Spring auto-configuration** for `Provider` / `Renderer` beans. Add when a real consumer needs it.
- **Coroutine wrappers** (`suspend fun loadDirectoryAsync(...)` etc.). Java loader + renderer are sync; Kotlin can wrap with `Dispatchers.IO` at call sites if needed.
- **DSL builders** for constructing MetaObjects in code (e.g., `entity("Foo") { field<String>("name") }`). Java mutator API works directly from Kotlin; no DSL adds enough value to justify the parallel surface.
- **Custom MetaObject/MetaField/Provider/MetaDataSource subtypes** — Kotlin subclasses Java directly; document the pattern in README.
- **Per-render verify integration** — the Java Renderer doesn't yet wire `RenderRequest.verify` through to `Verify.check()`; that's a Java-side follow-up, not metadata-ktx scope. The Kotlin `verify(...)` shortcut covers the standalone path.

## 9. Migration impact

None — new module. No existing consumers.

## 10. Risks

1. **Some Java API names may differ from this spec** (e.g., `getMetaObjectByName` vs `findMetaObject`, `findChildByType` vs `getChildOfType`). Mitigation: implementation-plan tasks verify exact API by reading `MetaDataLoader.java` and friends; fix inline.
2. **Java's `MetaRelationship.cardinality` / `MetaIdentity.generation` getter names may differ.** Mitigation: same — verify at impl time.
3. **The `MetaDataNotFoundException` may not be the exception that `MetaDataLoader.getMetaObjectByName` actually throws** (could be a generic `MetaDataException` instead). Mitigation: write `metaObjectOrNull`'s `try/catch` against whatever the engine actually throws after verifying.

## 11. Cross-references

- Locked memory entry: `[[metadata-ktx-facade-design]]`
- Sibling pattern: `server/java/omdb-ktx/` (template for module layout, pom, test wiring)
- Java FR-004 spec: `docs/superpowers/specs/2026-05-25-fr-004-java-template-port-design.md`
- Loader unification spec: `docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md`
