# Migration Guide

## Migrating from 6.x to 7.0.0

7.0.0 is the first publish from the consolidated `server/java/` reactor under the cross-language MetaObjects monorepo. Most consumers' migration is a version bump — the bulk of the work moved underneath the API. The full release notes are in [RELEASE_NOTES.md](RELEASE_NOTES.md).

### Step 1 — bump the version

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata</artifactId>
    <version>7.0.0</version>
</dependency>
```

Maven coordinates are unchanged from 6.x — `com.metaobjects:*` on Maven Central. Group IDs and artifact names stay the same except for new modules listed below.

### Step 2 — module additions you can opt into

Five module additions in 7.0.0 (none required; opt in per stack):

| Module | When you need it |
|---|---|
| `metaobjects-codegen-spring` | Generate Spring REST controllers + DTOs + JPA repositories + filter allowlists from metadata |
| `metaobjects-codegen-kotlin` | Generate idiomatic Kotlin (entity / Exposed table / Spring controller / payload / validator / stored-proc) on KotlinPoet |
| `metaobjects-render` | Mustache render + payload-VO codegen + drift-`verify` (the prompt-construction pillar) |
| `metaobjects-metadata-ktx` | Kotlin facade over the Java metadata core |
| `metaobjects-omdb-ktx` | Kotlin facade over OMDB |

The `metaobjects-dynamic-core` module from 6.x is gone — its `CoreObjectsMetaDataProvider` (which contributed `dataBuilderClass`, `valueObjectType`, etc., attribute extensions onto `object.base`) now ships inside `metaobjects-metadata`. Consumers of those attribute names need no change; consumers of the `metaobjects-dynamic-core` artifact coordinate should drop the dependency.

### OSGi support removed

The OSGi runtime variant (`OSGIServiceRegistry`, `BundleLifecycleManager`, the `maven-bundle-plugin` packaging on every reactor module) was dropped in 7.0.1. The artifacts are now plain JARs.

Consumers running inside an OSGi container can still wrap MetaObjects' JARs with `bnd` / `pax-url` to produce bundles with the appropriate manifest headers — the code itself works in any classloader environment. What changes:

- `<packaging>bundle</packaging>` is now `<packaging>jar</packaging>` on every module; no `Bundle-SymbolicName` / `Export-Package` manifest entries are emitted.
- `ServiceRegistry.isOSGIEnvironment()`, `onBundleEvent(Object)`, `cleanupForBundle(Object)`, `isBundleLifecycleActive()`, `getBundleLifecycleStatus()` are gone from the interface (they had no callers outside the OSGi implementation itself).
- `StandardServiceRegistry` is the only `ServiceRegistry` implementation.
- `ServiceRegistryFactory.create()` and `.getDefault()` return a `StandardServiceRegistry`. The OSGi auto-detection / `createOSGI(BundleContext)` factories are gone.

The `WeakReference` patterns in `MetaData`, `HybridCache`, and `StandardServiceRegistry` stay — they are general ClassLoader-leak prevention, not OSGi-specific.

The `metaobjects-codegen-mustache` and `metaobjects-codegen-plantuml` modules from 6.x continue unchanged.

### Step 3 — source paradigm v2 ([ADR-0007](../../spec/decisions/ADR-0007-source-paradigm-v2.md))

If your 6.x metadata declared a writable table via the legacy `source.dbTable` subtype, or a view via `source.dbView`, the canonical form is now:

```jsonc
{ "object.entity": {
    "name": "Subscriber",
    "children": [
      { "source.rdb": {
          "@kind": "table",
          "@table": "subscribers",
          "@schema": "public"
      }},
      { "field.string": {
          "name": "email",
          "@column": "email_address"
      }}
    ]
}}
```

- Source subtype: `source.rdb` (only) — `@kind` selects `table` / `view` / `materializedView` / `storedProc` / `tableFunction`. Read-only-ness is derived from `@kind`. Multi-source per object via `@role` (exactly one `primary`).
- Source physical name: `@table` (replaces `@name` on the source).
- Field physical name: `@column` (replaces `@dbColumn`).
- DB schema: `@schema` on the source (`public` default for Postgres; SQLite rejects non-default values).
- Referential actions on relationships: `@onDelete` / `@onUpdate` on the relationship, not on the source.

The legacy `source.dbTable` / `source.dbView` subtypes and the `@dbColumn` attribute are **retired**.

### Step 4 — FR5 actionable loader errors ([ADR-0009](../../spec/decisions/ADR-0009-actionable-loader-errors.md))

Loader errors now ship as structured envelopes with `errorCode`, `path`, `position`, `message`, and `hint` fields. If you parse loader-error output, switch to the envelope shape — the legacy flat-string format is gone.

### Step 5 — `verify` and prompt-construction (optional)

`mvn meta:verify` extends drift detection beyond entity codegen to prompt templates, output parsers, and database schema. Adopt it where you ship typed prompts or want compile-time gates against schema/code divergence.

The render pillar's payload-VO generator emits typed records for every `template.input` projection; FR-006 emits typed output parsers for every `template.output` schema. Both are opt-in additions — your existing entity codegen is unaffected.

### Step 6 — reactor housekeeping

The `archetype` and `examples` directories are still on disk as scaffold source but are no longer in the 7.0.0 reactor and are not deployed to Central. If you depended on them as Maven artifacts, copy the scaffold material into your own project tree.

---

## Migrating from 5.x to 6.x

The 5.x → 6.x migration changed the Maven group ID from `com.draagon` to `com.metaobjects` and refactored the package namespace from `com.draagon.meta.*` to `com.metaobjects.*`. The 6.x release notes have the per-package mapping. The recommended path for 5.x consumers today is **5.x → 7.0.0 directly** — there is no benefit to landing at an intermediate 6.x version.

For the 5.x → 6.x package rename, replace `com.draagon` group IDs and `com.draagon.meta.*` import statements with `com.metaobjects` and `com.metaobjects.*` respectively, then proceed with the 6.x → 7.0.0 steps above.

---

## Getting help

- Specification + ADRs: [`spec/`](../../spec/) at the repository root.
- Cross-language conformance corpora: [`fixtures/`](../../fixtures/).
- Issues: [github.com/metaobjectsdev/metaobjects/issues](https://github.com/metaobjectsdev/metaobjects/issues).
