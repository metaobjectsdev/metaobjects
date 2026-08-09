# Loaders

Every port ships a `MetaDataLoader` (or per-language equivalent) that takes a
metadata source (directory, classpath, raw string, or list of URIs), runs the
shared pipeline (parse → tree-build → super-resolve → validate), and returns a
queryable loader object. The loader API is shaped almost identically across
ports — a `fromDirectory` / `fromResources` / `fromString` family of static
factories — so a snippet in one port reads naturally in another.

The full design is in
[2026-05-25-cross-language-loader-architecture-unification.md](../superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md).

## Authoring side: same canonical JSON or YAML

The Author entity declaration (see [entities.md](entities.md)) lives in
`./metadata/meta.blog.json` or `./metadata/meta.blog.yaml`. The loader picks up
both formats; mixed-format directories are fine. Load order is a deterministic
ordinal-filename sort (because overlay merge is order-sensitive).

## What each port generates

### TypeScript

```ts
import { MetaDataLoader } from "@metaobjectsdev/metadata";

// From a directory (recursive)
const loader = await MetaDataLoader.fromDirectory("app", "./metadata");

// From an inline string
const inline = await MetaDataLoader.fromString(
  "test",
  '{ "metadata.root": { "package": "x", "children": [] } }',
);

// Navigation
const author = loader.metaObject("acme::blog::Author");
const nameField = author.field("name");                // throws if absent
const bioField  = author.findField("bio");             // null-returning
```

### Java

```java
import com.metaobjects.loader.MetaDataLoader;
import java.nio.file.Path;
import java.util.List;

// From a directory
MetaDataLoader dirLoader = MetaDataLoader.fromDirectory("app", Path.of("./metadata"));

// From classpath resources
MetaDataLoader resourceLoader = MetaDataLoader.fromResources("app", List.of("meta.blog.json"));

// From an inline string (JSON or YAML)
MetaDataLoader inline = MetaDataLoader.fromString(
    "test",
    "{ \"metadata.root\": { \"package\": \"x\", \"children\": [] } }",
    MetaDataSource.MetaDataFormat.JSON);

// Navigation
MetaObject author = dirLoader.getMetaObjectByName("acme::blog::Author");
MetaField name    = author.getMetaField("name");        // throws if absent
```

### Kotlin

`metaobjects-metadata-ktx` wraps the Java loader factories in idiomatic Kotlin
top-level functions and adds null-returning lookups + reified typed-field access.

```kotlin
import com.metaobjects.metadata.ktx.*
import com.metaobjects.field.StringField
import java.nio.file.Path

// From classpath resources
val loader = loadResources("app", listOf("meta.blog.json"))

// From a directory
val dirLoader = loadDirectory("app", Path.of("./metadata"))

// From an inline string (defaults to JSON; pass MetaDataFormat.YAML for YAML)
val inlineLoader = loadString("test", """{ "metadata.root": { "package": "x", "children": [] } }""")

// Null-returning lookup (idiomatic Kotlin)
val author = loader.metaObjectOrNull("acme::blog::Author")

// Reified typed field access
val name: StringField? = author?.field("name")             // null if absent or wrong type
val required: StringField = author!!.requireField("name")  // throws if absent
```

### C#

```csharp
using MetaObjects.Loader;

// From a directory
var loader = MetaDataLoader.FromDirectory("app", "./metadata");

// From classpath / file URIs
var uriLoader = MetaDataLoader.FromUris(
    "app", new[] { new Uri("file:./metadata/meta.blog.json") });

// From an inline string
var inline = MetaDataLoader.FromString(
    "test",
    """{ "metadata.root": { "package": "x", "children": [] } }""");

// Navigation
var author = loader.GetMetaObject("acme::blog::Author");
var nameField = author.GetField("name");
```

### Python

```python
from metaobjects.loader import MetaDataLoader

# From a directory
loader = MetaDataLoader.from_directory("app", "./metadata")

# From an inline string
inline = MetaDataLoader.from_string(
    "test",
    '{ "metadata.root": { "package": "x", "children": [] } }',
)

# Navigation
author = loader.meta_object("acme::blog::Author")
name = author.field("name")
```

## Pipeline (identical across ports)

1. **Discover sources.** Directory scan picks up `*.json` + `*.yaml`/`*.yml`
   recursively. Ordinal-filename sort gives a deterministic load order.
2. **Parse.** YAML is desugared to canonical JSON first (sigil-free → `@`-prefixed).
   See [yaml-authoring.md](yaml-authoring.md). JSON is parsed directly.
3. **Tree-build.** Each parsed file becomes a tree of `MetaData` nodes. Same shape
   across ports.
4. **Overlay merge.** Files sharing the same `package` + object `name` are merged.
   Last-writer-wins on attribute conflicts; structural children accumulate.
5. **Super-resolve.** `extends:` is resolved after all files load (deferred, not
   eager) so a child can extend a base declared in any other file. Resolution is
   **order-independent** — a pure function of the source set — so a dotted
   `extends:` to a member the owner reaches through its OWN `extends:` (e.g.
   `extends: Owner.member` where `Owner` inherits `member`) resolves regardless of
   file enumeration order; the owner's chain is wired on demand before its members
   are read (#188).
6. **Validate.** Per-node validation runs; reserved-attr collisions, missing
   required attrs, bad enum members all surface here with `ERR_*` codes (see
   [`fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json)).

## Configurable options

| Option | All ports | Purpose |
|---|---|---|
| `name` | yes | A label for diagnostics ("app", "test", etc.) |
| Type-registration callback | yes | Register custom MetaObject / MetaField subtypes |
| Common-attribute registration | yes | `registerCommonAttribute` adds documentation attrs (`description`, `notes`, etc.) to every node type |

## Errors

Every port emits the same error codes (`ERR_RESERVED_ATTR`,
`ERR_MISSING_REQUIRED_ATTR`, `ERR_BAD_ATTR_VALUE`, `ERR_DUPLICATE_NAME`, …) on
identical bad input. See
[`fixtures/conformance/ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json)
for the full enumeration; every entry has a matching `fixtures/conformance/error-*`
fixture that pins the cross-port behavior.

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Basic loader behavior**

- [`fixtures/conformance/loader-basic-single-entity/`](../../fixtures/conformance/loader-basic-single-entity/) — single entity file round-trip
- [`fixtures/conformance/loader-basic-empty-package/`](../../fixtures/conformance/loader-basic-empty-package/) — empty `package` allowed (top-level namespace)
- [`fixtures/conformance/loader-basic-explicit-subtype/`](../../fixtures/conformance/loader-basic-explicit-subtype/) — explicit `<type>.<subtype>` keying
- [`fixtures/conformance/loader-basic-multi-file-same-package/`](../../fixtures/conformance/loader-basic-multi-file-same-package/) — multiple files in one package
- [`fixtures/conformance/error-parse-malformed-json/`](../../fixtures/conformance/error-parse-malformed-json/) — malformed JSON surfaces a structured parse error

**All `fixtures/conformance/error-*` fixtures** double as a loader-error matrix; see the
[`ERROR-CODES.json`](../../fixtures/conformance/ERROR-CODES.json) enumeration. Each
error code has at least one matching fixture that pins the cross-port behavior.

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [yaml-authoring.md](yaml-authoring.md) — how YAML lowers to canonical JSON
- [entities.md](entities.md) — what the loader navigates
- [migrations-and-drift.md](migrations-and-drift.md) — `metaobjects:verify` runs the loader at build time
- [2026-05-25-cross-language-loader-architecture-unification.md](../superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md)
