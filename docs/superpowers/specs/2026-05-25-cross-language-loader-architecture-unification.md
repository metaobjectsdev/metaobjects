# Cross-Language Loader Architecture Unification

- **Date:** 2026-05-25
- **Status:** Design — plan-of-record. Authority for the metadata loader shape across all 4 ports going forward.
- **Supersedes:** the implicit two-class `MetaDataLoader` + `FileMetaDataLoader` hierarchy currently in TS/C#/Java, and Python's free-function `load_directory()` design.
- **Related:** [ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md) (YAML authoring as a sigil-free front-end; canonical JSON is interchange).

## 1. Context

The four ports' loader architectures diverged organically:

| Port | Loader shape | File loading |
|---|---|---|
| **TS** | `MetaDataLoader` (base) + `FileMetaDataLoader extends` | `loadDirectory(dir, opts)` on the subclass; YAML support added in the subclass override |
| **Java** | `MetaDataLoader` (base) + `FileMetaDataLoader extends` (under `loader/file/`) | Configured via `FileMetaDataSources` / `LocalFileMetaDataSources` / `URIFileMetaDataSources` |
| **C#** | `MetaDataLoader` (base) + `FileMetaDataLoader : MetaDataLoader` (flat in `Loader/`) | Constructor variants; uses `FileSource` directly |
| **Python** | **No class** — module-level `load_directory(input_dir, providers)` returning `LoadResult` | Directory-only; no other source types |

Two consistency problems and one extensibility problem:

1. **Cosmetic asymmetry** in the OO ports — TS puts the file class under `core/` (alongside parsers), Java under `loader/file/`, C# flat in `Loader/`. None match each other exactly.
2. **Python diverges structurally** — it has no `MetaDataSource` abstraction at all, and the loader is a free function rather than a class.
3. **Python is directory-bound** — `load_directory(dir)` can't naturally extend to URI loading, in-memory metadata, or stream loading. These will be needed (the user has confirmed in-memory and URI sources are real upcoming needs).

The OO ports' two-class hierarchy isn't pulling weight: `FileMetaDataLoader` exists to add (a) directory discovery and (b) YAML parsing. Both can move elsewhere — discovery into a Source factory, YAML into the parser dispatch keyed on the source's declared format — leaving the subclass with nothing to do.

## 2. Decision

A **single `MetaDataLoader` class in every port**, paired with a **polymorphic `MetaDataSource`** abstraction. No `FileMetaDataLoader` subclass anywhere. The loader is source-agnostic: it takes a list of sources, runs parse → merge → super-resolve → validate → freeze → return `LoadResult`. File / URI / in-memory / stream loading are all just different `MetaDataSource` implementations.

## 3. The `MetaDataSource` contract

Every source declares three pieces of information:

1. **Identity** (`String`) — a stable name for error messages: a file path, a URI, or `"<inline>"` / `"<test>"` for in-memory sources. Used in `MetaError.location`.
2. **Content** — the raw bytes. Eagerly held (for in-memory/file) or lazily fetched (for URI/stream); the source decides. Loader treats it as `String content()` (UTF-8 already decoded).
3. **Format** (`"json" | "yaml"`) — declared by the source, not sniffed by the loader. File sources default to extension-derived (`.json` → `"json"`; `.yaml` / `.yml` → `"yaml"`). In-memory and URI sources accept format as a constructor parameter.

**Why "format declared by the source"** (vs. parser sniffing): generalizes uniformly across file / URI / in-memory / stream. An in-memory YAML string in a test can declare its format explicitly without needing a filename-with-extension hack. Aligns with how TS currently does it.

### Concrete `MetaDataSource` implementations (every port ships these)

- **`FileSource`** — single file. Constructor: `FileSource(path, format=auto)`. Auto-detect format from extension.
- **`DirectorySource`** — expands into a sorted list of `FileSource`s. Constructor: `DirectorySource(dir, options?)` where `options` includes `exclude` (glob patterns) and `recurse: boolean` (default `true` — matches TS/Python current behavior). Today's `loadDirectory()` semantics, reified as a source-set. The "ordinal sort for deterministic overlay order" rule is enforced here.
- **`UriSource`** — fetches from an HTTP/`file://`/resource URI. Constructor: `UriSource(uri, format)`. Java already has this concept under `URIMetaDataSource`.
- **`InMemoryStringSource`** — in-memory content, no I/O. Constructor: `InMemoryStringSource(content, format, identity?)`. Java already has this as `InMemoryMetaDataSource`. The default identity is `"<inline>"`.
- *(Optional, deferred — `StreamSource` for true streaming/large-file scenarios. Not in initial scope.)*

Each port may add factory methods on these to compose them (`DirectorySource.expand()` returns the list of FileSources, etc.) — that's idiomatic, not contractual.

## 4. The `MetaDataLoader` API

Every port: **one** class, source-agnostic, no subclasses.

### Instance API (the durable shape)

```
loader = MetaDataLoader(options?)              # construct with options (typeRegistry, strict, freeze, etc.)
result = loader.load([source1, source2, ...])  # returns LoadResult { root, errors, warnings }
```

`LoadResult` is the cross-language invariant — same field shape across all ports.

### Static / factory convenience (idiomatic per port)

Every port exposes "the 99% case" via factories on the class:

```
MetaDataLoader.fromDirectory(dir, options?)    # builds a DirectorySource and loads
MetaDataLoader.fromUris([...])                 # builds UriSources and loads
MetaDataLoader.fromString(content, format)     # builds an InMemoryStringSource and loads
```

Per-port idiom for how these are named/exposed:
- **Java / C#** — static methods on `MetaDataLoader` (matches `createFromURIs(name, uris)` / `createFromResources(name, resources)` Java already has).
- **TS** — exported static methods on the class **plus** top-level named exports (`loadDirectory(...)`, `loadUris(...)`, `loadString(...)`) for ergonomic shorthand. Both forms ship; the named exports are one-liners delegating to the class.
- **Python** — `@classmethod` on `MetaDataLoader` **plus** module-level shortcuts (`metaobjects.load_directory(dir)`, `metaobjects.load_uris(uris)`, `metaobjects.load_string(content, format)`) — both delegate to the class. Module-level shortcuts honor the Pythonic `requests.get(url)` ergonomic pattern that today's `load_directory()` already follows; the class makes non-trivial cases possible.

### YAML detection

The loader's `parseSource(source, opts)` dispatches on `source.format`:
- `"json"` → canonical JSON parser.
- `"yaml"` → YAML parser → `yaml-desugar` → canonical JSON shape → canonical JSON parser.

This replaces both TS's `FileMetaDataLoader.parseSource` override AND Python's `_parse_file` extension-switch. Now a one-place dispatch keyed on the source's declared format.

## 5. What gets deleted per port

| Port | Deletes | Adds / Refactors |
|---|---|---|
| **TS** | `FileMetaDataLoader` (`metadata/src/core/file-meta-data-loader.ts`) | Move `FileSource` to `metadata/src/loader/sources/`; add `DirectorySource`, `UriSource`, `InMemoryStringSource` siblings; consolidate the directory-discovery into `DirectorySource`. `MetaDataLoader` grows the static factories + YAML dispatch on `parseSource()`. |
| **Java** | `FileMetaDataLoader` (`metadata/.../loader/file/FileMetaDataLoader.java`) + the four `*MetaDataSources.java` helper classes (collapsed into `DirectorySource` / `UriSource` / `InMemoryStringSource`) | Move sources to `metadata/.../loader/sources/`. `MetaDataLoader` already has `createFromURIs` / `createFromResources` — rename to match the cross-port `fromUris` / `fromDirectory` convention. Re-point all consumers. |
| **C#** | `FileMetaDataLoader.cs` | Add `DirectorySource.cs`, `InMemoryStringSource.cs` siblings to `FileSource.cs` + `UriSource.cs`. `MetaDataLoader` grows static factories + YAML dispatch. |
| **Python** | `load_directory(...)` free function in `meta_data_loader.py` (replaced) | Replace the entire module with a `MetaDataLoader` class. Add `metaobjects/loader/sources/` with `file_source.py`, `directory_source.py`, `uri_source.py`, `in_memory_string_source.py`. Re-export module-level shortcuts (`metaobjects.load_directory`, etc.) as thin wrappers on `MetaDataLoader.from_directory`. |

## 6. Migration approach — aggressive, single PR per port

No backwards-compatibility windows. **User explicitly waived this for TS** (their npm `0.6.0` consumers are their own projects — they'll fix as needed). C#/Java/Python have no published consumers. Same approach for all 4:

1. One PR per port that delivers the full unified API + migrates all internal call sites.
2. `FileMetaDataLoader` deleted in that PR. Tests + examples + docs updated.
3. Per-port ports can land independently — the cross-language invariants (`LoadResult` shape, `MetaDataSource` semantics) are stable so divergence in arrival order is fine.

Order (lowest churn first, biggest churn last):
1. **C#** — already flat in `Loader/`; smallest restructure.
2. **Java** — collapses the `loader/file/` subdir; medium churn.
3. **TS** — relocates from `core/` to a new `loader/sources/`; touches the barrel exports.
4. **Python** — biggest reshape (function → class + sources package); most flexibility since it's earliest-stage.

## 7. Tier classification (per the cross-language-porting skill)

- **Tier 1 — Invariant (must match across ports):**
  - `LoadResult { root, errors, warnings }` shape.
  - `MetaDataSource` contract: identity / content / format.
  - Source format vocabulary: `"json"` and `"yaml"` (strings; lowercase).
  - Source impl roster: `FileSource`, `DirectorySource`, `UriSource`, `InMemoryStringSource` exist in every port.
  - Loader pipeline semantics: parse → merge → super-resolve → validate → freeze. Returns errors/warnings; doesn't throw on metadata-level errors (only on programmer errors like missing required ctor args).
  - Deterministic source order in `DirectorySource`: ordinal filename sort.

- **Tier 2 — Idiomatic (per-port):**
  - Class/static naming: `fromDirectory` (Java/C#) vs `from_directory` (Python).
  - Module-level convenience: present in TS/Python, not in Java/C# (which prefer class-only).
  - Async/sync: TS async; Java/C#/Python sync.
  - Exception vs result-object: errors are returned in `LoadResult.errors` (not thrown) — this is Tier 1; how callers idiomatically check / unwrap is Tier 2.
  - File package directory naming: each port uses its own idiom (TS `loader/sources/`, Java `loader/sources/`, C# `Loader/Sources/`, Python `loader/sources/`). The `file/` subdir disappears.

- **Tier 3 — Free (internal):**
  - Whether `DirectorySource` holds a lazy iterator vs eager list.
  - How `UriSource` does HTTP (built-in vs library).
  - Internal class organization within `loader/`.

## 8. Out of scope

- **`StreamSource`** — true streaming/chunked I/O. Add when a real use case lands.
- **Async APIs for sync ports** — Java/C#/Python stay sync. Async is a TS-only Tier 2 concern.
- **A separate "registry loading" abstraction.** The loader already returns a frozen `MetaRoot` registered via providers — no separate registry-loader needed.
- **Auto-detection of format from CONTENT** (sniffing the bytes). Format is declared, not sniffed. Source factories may default-derive format from extension (`FileSource`) but that's a constructor-time auto-default, not a runtime sniff.

## 9. Testing strategy

Per port:
- Unit tests per `MetaDataSource` impl (FileSource, DirectorySource, UriSource, InMemoryStringSource).
- Loader integration tests: load a mix of sources (e.g., a directory + an in-memory override) and assert merged `LoadResult`.
- YAML dispatch test: an in-memory YAML source loads identically to its canonical-JSON equivalent.
- Migration regression tests: every former `FileMetaDataLoader` callsite continues to work via the new API.

The shared **conformance corpus is unchanged** — fixtures already use file/directory loading; the new API loads them via `MetaDataLoader.fromDirectory(fixtures/conformance/...)` or equivalent. Java's `ConformanceTest` harness re-points one line.

## 10. Cross-references

- [ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md) — YAML authoring (the `format` field on `MetaDataSource` is how YAML support is exposed; canonical JSON is the on-disk interchange).
- WA4 spec (`docs/superpowers/specs/2026-05-23-java-standard-alignment-and-loader-consolidation-design.md`) — Java's already-shipped collapse of the `core` module is the prerequisite for Java's part of this work.
- [Cross-language porting guide](../../spec/cross-language-porting-guide.md) — Tier framework used in §7.
