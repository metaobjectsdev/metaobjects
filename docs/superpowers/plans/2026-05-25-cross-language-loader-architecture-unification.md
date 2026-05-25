# Cross-Language Loader Architecture Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the metadata loader shape across all 4 ports (TS / Java / C# / Python) on a single `MetaDataLoader` class + polymorphic `MetaDataSource`. Delete `FileMetaDataLoader` everywhere. Replace Python's free `load_directory()` with a class + module-level shortcuts.

**Architecture:** Every port ships one `MetaDataLoader` class plus four `MetaDataSource` impls (`FileSource`, `DirectorySource`, `UriSource`, `InMemoryStringSource`). The loader is source-agnostic — it accepts a list of sources, dispatches parse on the source's declared `format` ("json" | "yaml"), and runs the existing parse → merge → super-resolve → validate → freeze pipeline. Per-port idiom: Java/C# expose static factory methods only; TS/Python expose static factories **plus** module-level convenience functions.

**Tech Stack:** TS (Bun/Node), Java 21 (Maven), C# (.NET 9), Python 3.12 (pytest). Shared conformance corpus at `fixtures/conformance/`.

**Source spec:** [docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md](../specs/2026-05-25-cross-language-loader-architecture-unification.md)

**Per-port gate:** After each port's tasks complete, run **code-reviewer + code-simplifier** subagents, apply findings, then merge that port's branch forward into `main` (FF/merge — never rewrite main). Order: **C# → Java → TS → Python**.

---

## File Structure (per port)

### C# (smallest churn — already flat in `Loader/`)
```
server/csharp/MetaObjects/Loader/
├── MetaDataLoader.cs           # MODIFY: add From* static factories; absorb YAML dispatch (already there)
├── MetaDataSource.cs           # MODIFY: rename InMemorySource → InMemoryStringSource
├── FileSource.cs               # KEEP (unchanged behavior)
├── DirectorySource.cs          # CREATE
├── UriSource.cs                # CREATE
└── FileMetaDataLoader.cs       # DELETE
```

### Java (collapse `loader/file/` subdir)
```
server/java/metadata/src/main/java/com/metaobjects/loader/
├── MetaDataLoader.java                    # MODIFY: rename createFromURIs → fromUris, add fromDirectory/fromString
├── MetaDataSource.java                    # KEEP (interface)
├── FileSource.java                        # CREATE (single-file impl)
├── DirectorySource.java                   # CREATE (replaces *MetaDataSources helpers)
├── UriSource.java                         # CREATE (replaces URIMetaDataSource, kebabbed)
├── InMemoryStringSource.java              # RENAME from InMemoryMetaDataSource
└── file/                                  # DELETE entire directory
    ├── FileMetaDataLoader.java            # DELETE
    ├── FileMetaDataSources.java           # DELETE
    ├── LocalFileMetaDataSources.java      # DELETE
    ├── URIFileMetaDataSources.java        # DELETE
    └── FileLoaderOptions.java             # DELETE (settings merged into LoaderOptions or DirectorySource.Options)
```

### TS (relocate from `core/` to `loader/sources/`)
```
server/typescript/packages/metadata/src/
├── loader/
│   ├── meta-data-loader.ts                # MODIFY: add static factories; fold YAML dispatch into parseSource
│   ├── meta-data-source.ts                # MODIFY: rename InMemorySource → InMemoryStringSource
│   └── sources/                           # CREATE directory
│       ├── file-source.ts                 # MOVE from src/core/file-source.ts
│       ├── directory-source.ts            # CREATE
│       ├── uri-source.ts                  # CREATE
│       └── index.ts                       # CREATE (barrel)
├── core/
│   ├── file-meta-data-loader.ts           # DELETE
│   ├── file-source.ts                     # MOVE (file gone — moved into loader/sources/)
│   ├── parser-yaml.ts                     # KEEP (now imported from loader/meta-data-loader.ts)
│   └── index.ts                           # MODIFY: drop FileMetaDataLoader + FileSource exports
└── index.ts                               # MODIFY: export new sources + add module-level loadDirectory/loadUris/loadString
```

### Python (free function → class + sources package)
```
server/python/src/metaobjects/
├── loader/
│   ├── meta_data_loader.py               # REWRITE: free fn → MetaDataLoader class
│   └── sources/                          # CREATE directory
│       ├── __init__.py                   # CREATE (re-exports)
│       ├── meta_data_source.py           # CREATE (ABC + InMemoryStringSource)
│       ├── file_source.py                # CREATE
│       ├── directory_source.py           # CREATE
│       └── uri_source.py                 # CREATE
└── __init__.py                           # MODIFY: add module-level load_directory/load_uris/load_string + export class
```

---

# Phase 1 — C# port (lowest churn)

**Branch:** `worktree-loader-unify-csharp` (or work in current `worktree-postwa4-scratch` — operator's choice). All commits on that branch; final merge into `main` after gate.

---

### Task 1.1: Rename `InMemorySource` → `InMemoryStringSource`

**Files:**
- Modify: `server/csharp/MetaObjects/Loader/MetaDataSource.cs`
- Modify: all C# call sites (use grep to find every `InMemorySource(` and `new InMemorySource`)

- [ ] **Step 1: Rename the class**

In `server/csharp/MetaObjects/Loader/MetaDataSource.cs`:

```csharp
public sealed class InMemoryStringSource : IMetaDataSource
{
    private readonly string _content;
    public string Id { get; }
    public MetaDataFormat Format { get; }

    public InMemoryStringSource(
        string content,
        string id = "<inline>",
        MetaDataFormat format = MetaDataFormat.Json)
    {
        _content = content ?? throw new ArgumentNullException(nameof(content));
        Id = id ?? "<inline>";
        Format = format;
    }

    public string Read() => _content;
}
```

Note the default `id` is now `"<inline>"` (matches the cross-language convention).

- [ ] **Step 2: Find and rewrite call sites**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
grep -rn 'InMemorySource' server/csharp --include='*.cs'
```

For each match, replace `InMemorySource` with `InMemoryStringSource`. The constructor signature is compatible (positional args identical) so it's a pure rename.

- [ ] **Step 3: Build and run tests**

```bash
cd server/csharp && dotnet test
```

Expected: PASS (all tests).

- [ ] **Step 4: Commit**

```bash
git add server/csharp
git commit -m "refactor(csharp): rename InMemorySource → InMemoryStringSource"
```

---

### Task 1.2: Add `DirectorySource`

**Files:**
- Create: `server/csharp/MetaObjects/Loader/DirectorySource.cs`
- Test: `server/csharp/MetaObjects.Tests/Loader/DirectorySourceTests.cs`

- [ ] **Step 1: Write the failing test**

`server/csharp/MetaObjects.Tests/Loader/DirectorySourceTests.cs`:

```csharp
using System.IO;
using System.Linq;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Tests.Loader;

public class DirectorySourceTests
{
    [Fact]
    public void Expand_ReturnsFileSourcesSortedByOrdinalName()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "b.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "a.yaml"), "");
            File.WriteAllText(Path.Combine(dir, "ignored.txt"), "x");

            var src = new DirectorySource(dir);
            var expanded = src.Expand().ToList();

            Assert.Equal(2, expanded.Count);
            Assert.Equal("a.yaml", expanded[0].Id);
            Assert.Equal(MetaDataFormat.Yaml, expanded[0].Format);
            Assert.Equal("b.json", expanded[1].Id);
            Assert.Equal(MetaDataFormat.Json, expanded[1].Format);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Expand_HonorsExcludeGlobs()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.alpha.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "meta.beta.json"), "{}");

            var src = new DirectorySource(dir, new DirectorySource.Options { Exclude = new[] { "meta.beta.json" } });
            var expanded = src.Expand().ToList();

            Assert.Single(expanded);
            Assert.Equal("meta.alpha.json", expanded[0].Id);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~DirectorySourceTests
```

Expected: FAIL — `DirectorySource` does not exist.

- [ ] **Step 3: Implement `DirectorySource`**

`server/csharp/MetaObjects/Loader/DirectorySource.cs`:

```csharp
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace MetaObjects.Loader;

/// <summary>
/// A directory of metadata files. Discovers .json / .yaml / .yml files and
/// expands into a deterministically-ordered list of <see cref="FileSource"/>.
/// </summary>
public sealed class DirectorySource
{
    public sealed class Options
    {
        public IReadOnlyList<string>? Exclude { get; init; }
        public bool Recurse { get; init; } = true;
    }

    private static readonly HashSet<string> _supported =
        new(System.StringComparer.OrdinalIgnoreCase) { ".json", ".yaml", ".yml" };

    public string Directory { get; }
    public Options Opts { get; }

    public DirectorySource(string directory, Options? opts = null)
    {
        Directory = directory ?? throw new System.ArgumentNullException(nameof(directory));
        Opts = opts ?? new Options();
    }

    public IEnumerable<FileSource> Expand()
    {
        var search = Opts.Recurse ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
        var files = System.IO.Directory.EnumerateFiles(Directory, "*", search)
            .Where(p => _supported.Contains(Path.GetExtension(p)));

        if (Opts.Exclude is { Count: > 0 } excludes)
        {
            files = files.Where(p => !excludes.Any(e => MatchesGlob(Path.GetFileName(p), e)));
        }

        return files
            .OrderBy(p => p, System.StringComparer.Ordinal)
            .Select(p => new FileSource(p));
    }

    private static bool MatchesGlob(string name, string pattern)
    {
        // Simple glob: supports literal match and trailing/leading "*".
        if (pattern == name) return true;
        if (pattern.StartsWith("*") && name.EndsWith(pattern[1..], System.StringComparison.Ordinal)) return true;
        if (pattern.EndsWith("*") && name.StartsWith(pattern[..^1], System.StringComparison.Ordinal)) return true;
        return false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~DirectorySourceTests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/Loader/DirectorySource.cs server/csharp/MetaObjects.Tests/Loader/DirectorySourceTests.cs
git commit -m "feat(csharp): add DirectorySource (Source impl for directory expansion)"
```

---

### Task 1.3: Add `UriSource`

**Files:**
- Create: `server/csharp/MetaObjects/Loader/UriSource.cs`
- Test: `server/csharp/MetaObjects.Tests/Loader/UriSourceTests.cs`

- [ ] **Step 1: Write the failing test**

`server/csharp/MetaObjects.Tests/Loader/UriSourceTests.cs`:

```csharp
using System;
using System.IO;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Tests.Loader;

public class UriSourceTests
{
    [Fact]
    public void FileScheme_ReadsLocalFile()
    {
        var path = Path.Combine(Path.GetTempPath(), "u_" + Path.GetRandomFileName() + ".json");
        File.WriteAllText(path, "{\"metadata.root\":{}}");
        try
        {
            var src = new UriSource(new Uri("file://" + path));
            Assert.Equal(MetaDataFormat.Json, src.Format);
            Assert.Equal("{\"metadata.root\":{}}", src.Read());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void ExplicitFormat_OverridesExtensionInference()
    {
        var path = Path.Combine(Path.GetTempPath(), "u_" + Path.GetRandomFileName() + ".txt");
        File.WriteAllText(path, "metadata.root: {}");
        try
        {
            var src = new UriSource(new Uri("file://" + path), MetaDataFormat.Yaml);
            Assert.Equal(MetaDataFormat.Yaml, src.Format);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~UriSourceTests
```

Expected: FAIL — `UriSource` does not exist.

- [ ] **Step 3: Implement `UriSource`**

`server/csharp/MetaObjects/Loader/UriSource.cs`:

```csharp
using System;
using System.IO;
using System.Net.Http;

namespace MetaObjects.Loader;

/// <summary>
/// A URI-backed metadata source. Supports file://, http://, and https:// schemes.
/// Format defaults to extension-derived; pass an explicit <see cref="MetaDataFormat"/>
/// to override.
/// </summary>
public sealed class UriSource : IMetaDataSource
{
    private static readonly HttpClient _http = new();

    public Uri Uri { get; }
    public string Id { get; }
    public MetaDataFormat Format { get; }

    public UriSource(Uri uri, MetaDataFormat? format = null)
    {
        Uri = uri ?? throw new ArgumentNullException(nameof(uri));
        Id = uri.ToString();
        Format = format ?? InferFormatFromExtension(uri.AbsolutePath);
    }

    public string Read()
    {
        if (Uri.IsFile)
        {
            return File.ReadAllText(Uri.LocalPath);
        }

        if (Uri.Scheme == "http" || Uri.Scheme == "https")
        {
            using var resp = _http.GetAsync(Uri).GetAwaiter().GetResult();
            resp.EnsureSuccessStatusCode();
            return resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        }

        throw new NotSupportedException($"Unsupported URI scheme '{Uri.Scheme}' on {Uri}");
    }

    private static MetaDataFormat InferFormatFromExtension(string path)
    {
        var ext = Path.GetExtension(path);
        return ext.Equals(".yaml", StringComparison.OrdinalIgnoreCase)
               || ext.Equals(".yml", StringComparison.OrdinalIgnoreCase)
            ? MetaDataFormat.Yaml
            : MetaDataFormat.Json;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~UriSourceTests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp/MetaObjects/Loader/UriSource.cs server/csharp/MetaObjects.Tests/Loader/UriSourceTests.cs
git commit -m "feat(csharp): add UriSource (file://, http://, https:// scheme support)"
```

---

### Task 1.4: Add static factories on `MetaDataLoader`

**Files:**
- Modify: `server/csharp/MetaObjects/Loader/MetaDataLoader.cs`
- Test: `server/csharp/MetaObjects.Tests/Loader/MetaDataLoaderFactoryTests.cs`

- [ ] **Step 1: Write the failing test**

`server/csharp/MetaObjects.Tests/Loader/MetaDataLoaderFactoryTests.cs`:

```csharp
using System.IO;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Tests.Loader;

public class MetaDataLoaderFactoryTests
{
    [Fact]
    public void FromDirectory_LoadsAndReturnsRoot()
    {
        var dir = Path.Combine(Path.GetTempPath(), "fl_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.tiny.json"),
                "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}");
            var result = MetaDataLoader.FromDirectory(dir);
            Assert.Empty(result.Errors);
            Assert.NotNull(result.Root);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void FromString_LoadsInlineJson()
    {
        var result = MetaDataLoader.FromString(
            "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}",
            MetaDataFormat.Json);
        Assert.Empty(result.Errors);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~MetaDataLoaderFactoryTests
```

Expected: FAIL — `FromDirectory` / `FromString` do not exist.

- [ ] **Step 3: Add the static factories**

Edit `server/csharp/MetaObjects/Loader/MetaDataLoader.cs`. After the constructors, before `Load(...)`:

```csharp
    // --- Static factories (the 99% case) ---

    /// <summary>Convenience: build a <see cref="DirectorySource"/> and load it.</summary>
    public static LoadResult FromDirectory(string directory, DirectorySource.Options? opts = null)
    {
        var src = new DirectorySource(directory, opts);
        var loader = new MetaDataLoader();
        return loader.Load(src.Expand().Cast<IMetaDataSource>().ToList());
    }

    /// <summary>Convenience: build <see cref="UriSource"/>s and load them.</summary>
    public static LoadResult FromUris(IReadOnlyList<System.Uri> uris)
    {
        var loader = new MetaDataLoader();
        var sources = uris.Select(u => (IMetaDataSource)new UriSource(u)).ToList();
        return loader.Load(sources);
    }

    /// <summary>Convenience: load a single in-memory string of the given format.</summary>
    public static LoadResult FromString(string content, MetaDataFormat format)
    {
        var loader = new MetaDataLoader();
        return loader.Load(new IMetaDataSource[] { new InMemoryStringSource(content, format: format) });
    }
```

Add to the file's `using` section if not present:
```csharp
using System.Collections.Generic;
using System.Linq;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server/csharp && dotnet test --filter FullyQualifiedName~MetaDataLoaderFactoryTests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp
git commit -m "feat(csharp): MetaDataLoader.FromDirectory/FromUris/FromString static factories"
```

---

### Task 1.5: Migrate all callers off `FileMetaDataLoader`, delete it

**Files:**
- Modify: `server/csharp/MetaObjects.Cli/Commands/GenCommand.cs:27`
- Modify: `server/csharp/MetaObjects.Cli/Commands/MigrateCommand.cs:118`
- Modify: `server/csharp/MetaObjects.Cli/Commands/VerifyCommand.cs:44`
- Modify: `server/csharp/MetaObjects.Tests/Loader/LoaderTests.cs` (3 instances)
- Modify: `server/csharp/MetaObjects.Tests/Loader/ConformanceAdapter.cs:55`
- Modify: `server/csharp/MetaObjects.Tests/Loader/SuperResolveTests.cs` (2 instances)
- Modify: `server/csharp/MetaObjects.Tests/Loader/ValidationTests.cs:16`
- Delete: `server/csharp/MetaObjects/Loader/FileMetaDataLoader.cs`

- [ ] **Step 1: Replace every callsite**

For every `new FileMetaDataLoader().LoadDirectory(dir)` pattern, replace with `MetaDataLoader.FromDirectory(dir)`. For `new FileMetaDataLoader(registry).LoadDirectory(dir)`, replace with:

```csharp
var src = new DirectorySource(dir);
var loader = new MetaDataLoader(registry);
var result = loader.Load(src.Expand().Cast<IMetaDataSource>().ToList());
```

Use the inventory from Phase 1's spec — 3 CLI files + 10 test files. Find them all with:

```bash
grep -rn 'FileMetaDataLoader' server/csharp --include='*.cs'
```

For each test using `LoadFiles(paths)`, replace with:

```csharp
var sources = paths.Select(p => (IMetaDataSource)new FileSource(p)).ToList();
var result = new MetaDataLoader().Load(sources);
```

- [ ] **Step 2: Build to find missed references**

```bash
cd server/csharp && dotnet build
```

Expected: success. Fix any remaining references.

- [ ] **Step 3: Delete `FileMetaDataLoader.cs`**

```bash
git rm server/csharp/MetaObjects/Loader/FileMetaDataLoader.cs
```

- [ ] **Step 4: Run full test suite**

```bash
cd server/csharp && dotnet test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/csharp
git commit -m "refactor(csharp): retire FileMetaDataLoader; migrate to MetaDataLoader.FromDirectory + Source polymorphism"
```

---

### Task 1.6: C# review gate + merge

- [ ] **Step 1: Dispatch code-reviewer subagent**

Dispatch a `claude` agent (subagent_type general or code-reviewer if available) with the task: "Review the C# loader unification change in this worktree. Branch: current. Compare with the spec at `docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md`. Report any Critical/Important/Nit findings with file:line citations."

- [ ] **Step 2: Apply review findings**

Fix every Important. Nits at controller discretion.

- [ ] **Step 3: Dispatch code-simplifier**

Dispatch `code-simplifier` subagent: "Simplify the recently-modified C# loader code: `server/csharp/MetaObjects/Loader/` (all files) and `server/csharp/MetaObjects.Tests/Loader/`. Preserve all behavior."

- [ ] **Step 4: Re-run tests**

```bash
cd server/csharp && dotnet test
```

Expected: PASS.

- [ ] **Step 5: Merge to main**

```bash
# from the worktree
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
# advance the worktree branch first
CURRENT_BRANCH=$(git branch --show-current)
# fetch latest main
git fetch origin main
# merge into the worktree branch (not the other way) so we resolve conflicts in the worktree
git merge --no-ff origin/main || true   # only if there is divergence
# now advance main in the ORIGINAL checkout
git -C /home/doug/Development/metaobjects fetch
git -C /home/doug/Development/metaobjects checkout main
git -C /home/doug/Development/metaobjects pull --ff-only origin main
git -C /home/doug/Development/metaobjects merge --no-ff $CURRENT_BRANCH -m "Merge C# loader unification"
git -C /home/doug/Development/metaobjects push origin main
```

(See `superpowers:finishing-a-development-branch` for the canonical version of this dance; the key rule from memory `main-is-forward-only-never-rewrite` — never rebase/reset/force main; always FF/merge onto its current tip.)

---

# Phase 2 — Java port

**Branch:** `worktree-loader-unify-java`. Final merge after gate.

---

### Task 2.1: Rename `InMemoryMetaDataSource` → `InMemoryStringSource`

**Files:**
- Rename: `server/java/metadata/src/main/java/com/metaobjects/loader/InMemoryMetaDataSource.java` → `InMemoryStringSource.java`
- Modify: all Java call sites

- [ ] **Step 1: Rename file + class**

```bash
git mv server/java/metadata/src/main/java/com/metaobjects/loader/InMemoryMetaDataSource.java \
       server/java/metadata/src/main/java/com/metaobjects/loader/InMemoryStringSource.java
```

In the new file: replace `class InMemoryMetaDataSource` → `class InMemoryStringSource`. Default id should be `"<inline>"` (was `"<in-memory>"`):

```java
public InMemoryStringSource(String content) {
    this(content, "<inline>", MetaDataFormat.JSON);
}
```

- [ ] **Step 2: Update call sites**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
grep -rln 'InMemoryMetaDataSource' server/java --include='*.java' | \
  xargs sed -i 's/InMemoryMetaDataSource/InMemoryStringSource/g'
```

Confirm no leftover matches:

```bash
grep -rn 'InMemoryMetaDataSource' server/java
```

Expected: zero output.

- [ ] **Step 3: Compile**

```bash
cd server/java && mvn -pl metadata -am compile test-compile -q
```

Expected: success.

- [ ] **Step 4: Run metadata tests**

```bash
cd server/java && mvn -pl metadata test -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java
git commit -m "refactor(java): rename InMemoryMetaDataSource → InMemoryStringSource"
```

---

### Task 2.2: Rename `URIMetaDataSource` → `UriSource`

**Files:**
- Rename: `server/java/metadata/src/main/java/com/metaobjects/loader/URIMetaDataSource.java` → `UriSource.java`

- [ ] **Step 1: Rename file + class**

```bash
git mv server/java/metadata/src/main/java/com/metaobjects/loader/URIMetaDataSource.java \
       server/java/metadata/src/main/java/com/metaobjects/loader/UriSource.java
```

In the new file: replace `class URIMetaDataSource` → `class UriSource`. The constructor stays `public UriSource(URI uri)` (the `java.net.URI` parameter type doesn't change).

- [ ] **Step 2: Update call sites**

```bash
grep -rln 'URIMetaDataSource' server/java --include='*.java' | \
  xargs sed -i 's/URIMetaDataSource/UriSource/g'
```

Confirm:

```bash
grep -rn 'URIMetaDataSource' server/java
```

Expected: zero output.

- [ ] **Step 3: Compile + test**

```bash
cd server/java && mvn -pl metadata -am test -q
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/java
git commit -m "refactor(java): rename URIMetaDataSource → UriSource"
```

---

### Task 2.3: Create `FileSource`

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/loader/FileSource.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/loader/FileSourceTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.loader;

import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.Assert.*;

public class FileSourceTest {

    @Test public void readsJsonFileWithInferredFormat() throws IOException {
        Path p = Files.createTempFile("fs-", ".json");
        Files.writeString(p, "{\"metadata.root\":{}}");
        try {
            FileSource src = new FileSource(p);
            assertEquals(MetaDataSource.MetaDataFormat.JSON, src.getFormat());
            assertEquals(p.getFileName().toString(), src.getId());
            assertEquals("{\"metadata.root\":{}}", src.read());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void inferFormatFromYamlExtension() throws IOException {
        Path p = Files.createTempFile("fs-", ".yaml");
        try {
            FileSource src = new FileSource(p);
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void explicitFormatOverridesInference() throws IOException {
        Path p = Files.createTempFile("fs-", ".txt");
        try {
            FileSource src = new FileSource(p, MetaDataSource.MetaDataFormat.YAML);
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }
}
```

- [ ] **Step 2: Verify it fails**

```bash
cd server/java && mvn -pl metadata test -Dtest=FileSourceTest -q
```

Expected: FAIL — `FileSource` does not exist.

- [ ] **Step 3: Implement `FileSource`**

```java
package com.metaobjects.loader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Objects;

/**
 * A single-file metadata source. Reads file contents on demand; format is
 * inferred from extension (.yaml/.yml → YAML, else JSON) unless overridden.
 */
public final class FileSource implements MetaDataSource {

    private final Path path;
    private final MetaDataFormat format;

    public FileSource(Path path) {
        this(path, inferFormat(path));
    }

    public FileSource(Path path, MetaDataFormat format) {
        this.path = Objects.requireNonNull(path, "path");
        this.format = Objects.requireNonNull(format, "format");
    }

    @Override public String getId() { return path.getFileName().toString(); }
    @Override public MetaDataFormat getFormat() { return format; }

    @Override public String read() throws IOException {
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    public Path getPath() { return path; }

    private static MetaDataFormat inferFormat(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return (name.endsWith(".yaml") || name.endsWith(".yml"))
            ? MetaDataFormat.YAML
            : MetaDataFormat.JSON;
    }
}
```

- [ ] **Step 4: Test passes**

```bash
cd server/java && mvn -pl metadata test -Dtest=FileSourceTest -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/loader/FileSource.java \
        server/java/metadata/src/test/java/com/metaobjects/loader/FileSourceTest.java
git commit -m "feat(java): add FileSource (single-file MetaDataSource impl)"
```

---

### Task 2.4: Create `DirectorySource`

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/loader/DirectorySource.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/loader/DirectorySourceTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.loader;

import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import static org.junit.Assert.*;

public class DirectorySourceTest {

    @Test public void expandsReturnsFileSourcesSortedByOrdinalName() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("b.json"), "{}");
            Files.writeString(dir.resolve("a.yaml"), "");
            Files.writeString(dir.resolve("ignored.txt"), "x");

            DirectorySource src = new DirectorySource(dir);
            List<FileSource> expanded = src.expand().collect(Collectors.toList());

            assertEquals(2, expanded.size());
            assertEquals("a.yaml", expanded.get(0).getId());
            assertEquals(MetaDataSource.MetaDataFormat.YAML, expanded.get(0).getFormat());
            assertEquals("b.json", expanded.get(1).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void honorsExcludeNames() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.alpha.json"), "{}");
            Files.writeString(dir.resolve("meta.beta.json"), "{}");
            DirectorySource src = new DirectorySource(dir,
                new DirectorySource.Options().setExclude(List.of("meta.beta.json")));
            List<FileSource> expanded = src.expand().collect(Collectors.toList());
            assertEquals(1, expanded.size());
            assertEquals("meta.alpha.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    private static void deleteRecursively(Path p) throws IOException {
        if (Files.isDirectory(p)) {
            try (var s = Files.list(p)) {
                for (Path c : s.collect(Collectors.toList())) deleteRecursively(c);
            }
        }
        Files.deleteIfExists(p);
    }
}
```

- [ ] **Step 2: Verify it fails**

```bash
cd server/java && mvn -pl metadata test -Dtest=DirectorySourceTest -q
```

Expected: FAIL.

- [ ] **Step 3: Implement `DirectorySource`**

```java
package com.metaobjects.loader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * A directory of metadata files. Expands into a sorted stream of {@link FileSource}.
 * Discovers .json / .yaml / .yml files (case-insensitive). Recurses by default.
 */
public final class DirectorySource {

    public static final class Options {
        private List<String> exclude = List.of();
        private boolean recurse = true;
        public Options setExclude(List<String> excludeNames) { this.exclude = excludeNames; return this; }
        public Options setRecurse(boolean recurse) { this.recurse = recurse; return this; }
        public List<String> getExclude() { return exclude; }
        public boolean isRecurse() { return recurse; }
    }

    private static final Set<String> EXTENSIONS = Set.of(".json", ".yaml", ".yml");

    private final Path directory;
    private final Options opts;

    public DirectorySource(Path directory) {
        this(directory, new Options());
    }

    public DirectorySource(Path directory, Options opts) {
        this.directory = Objects.requireNonNull(directory, "directory");
        this.opts = Objects.requireNonNull(opts, "opts");
    }

    public Stream<FileSource> expand() {
        try {
            Stream<Path> walk = opts.isRecurse()
                ? Files.walk(directory)
                : Files.list(directory);
            return walk
                .filter(Files::isRegularFile)
                .filter(p -> hasSupportedExtension(p.getFileName().toString()))
                .filter(p -> !opts.getExclude().contains(p.getFileName().toString()))
                .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                .map(FileSource::new);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to list " + directory, e);
        }
    }

    private static boolean hasSupportedExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : EXTENSIONS) if (lower.endsWith(ext)) return true;
        return false;
    }
}
```

- [ ] **Step 4: Test passes**

```bash
cd server/java && mvn -pl metadata test -Dtest=DirectorySourceTest -q
```

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/loader/DirectorySource.java \
        server/java/metadata/src/test/java/com/metaobjects/loader/DirectorySourceTest.java
git commit -m "feat(java): add DirectorySource (replaces *MetaDataSources helpers)"
```

---

### Task 2.5: Add `fromDirectory` / `fromUris` / `fromString` static factories

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java` (existing `createFromURIs` / `createFromResources` stay but become thin wrappers around `fromUris`; eventually deprecated)

- [ ] **Step 1: Add factories to `MetaDataLoader`**

After the existing `createFromURIs(...)` block (around line 200), add:

```java
    // --- Unified static factories (cross-language consistent) ---

    /**
     * Build a {@link DirectorySource} for the given path and load all files in order.
     * Caller-friendly convenience for the 99% case.
     */
    public static MetaDataLoader fromDirectory(String name, Path directory) {
        return fromDirectory(name, directory, new DirectorySource.Options());
    }

    public static MetaDataLoader fromDirectory(String name, Path directory, DirectorySource.Options opts) {
        MetaDataLoader loader = createManual(false, name);
        try {
            List<MetaDataSource> sources = new DirectorySource(directory, opts)
                .expand()
                .map(fs -> (MetaDataSource) fs)
                .collect(Collectors.toList());
            loader.init();
            loader.load(sources);
            loader.register();
        } catch (Exception e) {
            throw new MetaDataLoadingException("Failed to load from directory " + directory, e);
        }
        return loader;
    }

    /** Build {@link UriSource}s and load them. Replaces {@link #createFromURIs(String, List)}. */
    public static MetaDataLoader fromUris(String name, List<URI> uris) {
        MetaDataLoader loader = createManual(false, name);
        try {
            loader.init();
            List<MetaDataSource> sources = uris.stream()
                .map(uri -> (MetaDataSource) new UriSource(uri))
                .collect(Collectors.toList());
            loader.load(sources);
            loader.register();
        } catch (Exception e) {
            throw new MetaDataLoadingException("Failed to load from URIs", e);
        }
        return loader;
    }

    /** Load a single in-memory string. */
    public static MetaDataLoader fromString(String name, String content, MetaDataSource.MetaDataFormat format) {
        MetaDataLoader loader = createManual(false, name);
        try {
            loader.init();
            loader.load(List.of(new InMemoryStringSource(content, "<inline>", format)));
            loader.register();
        } catch (Exception e) {
            throw new MetaDataLoadingException("Failed to load from string", e);
        }
        return loader;
    }
```

Add imports at the top if missing:
```java
import java.nio.file.Path;
import java.util.stream.Collectors;
```

- [ ] **Step 2: Write test**

`server/java/metadata/src/test/java/com/metaobjects/loader/MetaDataLoaderFactoryTest.java`:

```java
package com.metaobjects.loader;

import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.Assert.*;

public class MetaDataLoaderFactoryTest extends SharedRegistryTestBase {

    @Test public void fromDirectoryLoadsCanonicalJson() throws IOException {
        Path dir = Files.createTempDirectory("mdl-");
        Path file = dir.resolve("meta.tiny.json");
        Files.writeString(file, "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}");
        try {
            MetaDataLoader loader = MetaDataLoader.fromDirectory("test", dir);
            assertNotNull(loader.getRoot());
        } finally {
            Files.deleteIfExists(file);
            Files.deleteIfExists(dir);
        }
    }

    @Test public void fromStringLoadsInline() {
        MetaDataLoader loader = MetaDataLoader.fromString(
            "test",
            "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}",
            MetaDataSource.MetaDataFormat.JSON);
        assertNotNull(loader.getRoot());
    }
}
```

- [ ] **Step 3: Run test**

```bash
cd server/java && mvn -pl metadata test -Dtest=MetaDataLoaderFactoryTest -q
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/java
git commit -m "feat(java): add MetaDataLoader.fromDirectory/fromUris/fromString factories"
```

---

### Task 2.6: Migrate all callers off `FileMetaDataLoader`, delete `loader/file/`

**Files (production code):**
- `server/java/core-spring/src/main/java/com/metaobjects/spring/MetaDataLoaderConfiguration.java`
- `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/metadata/html/MetaDataHtmlDocumentationWriter.java`
- `server/java/examples/basic-example/src/main/java/com/metaobjects/examples/basic/BasicMetaObjectsExample.java`

**Files (tests):**
- `server/java/metadata/src/test/java/com/metaobjects/loader/file/FileMetaDataLoaderTest.java` (DELETE — replaced by FileSource/DirectorySource tests)
- `server/java/om/src/test/java/com/metaobjects/manager/xml/OMXMLTest.java`
- `server/java/omdb/src/test/java/com/metaobjects/manager/db/test/AbstractOMDBTest.java`
- `server/java/omdb/src/test/java/com/metaobjects/manager/db/JsonbFieldDBTest.java`
- `server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/SchemaMigrationEngineTest.java`
- `server/java/omdb/src/test/java/com/metaobjects/manager/db/migrate/ExpectedSchemaBuilderTest.java`
- `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MetaDataMigrateMojoTest.java`
- `server/java/metadata/src/test/java/com/metaobjects/object/proxy/ProxyObjectTests.java`
- `server/java/metadata/src/test/java/com/metaobjects/io/object/gson/GsonAdapterTest.java`
- `server/java/codegen-mustache/src/test/java/com/metaobjects/generator/mustache/MustacheTemplateEngineTest.java`

- [ ] **Step 1: Find all callsites**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
grep -rln 'FileMetaDataLoader\|LocalFileMetaDataSources\|URIFileMetaDataSources\|FileMetaDataSources\|FileLoaderOptions' server/java --include='*.java'
```

- [ ] **Step 2: Rewrite each callsite**

Pattern A — `new FileMetaDataLoader(name).init(new LocalFileMetaDataSources("meta.x.json"))`:
Replace with classpath resource loading:
```java
URL res = Thread.currentThread().getContextClassLoader().getResource("meta.x.json");
MetaDataLoader loader = MetaDataLoader.fromUris("test", List.of(res.toURI()));
```

Pattern B — `new FileMetaDataLoader(opts.addSources(new LocalFileMetaDataSources(dir, files)))`:
```java
MetaDataLoader loader = MetaDataLoader.fromDirectory("test", Path.of(dir));
```

Pattern C — Spring config `new MetaDataLoader(...).setSourceURIs(...).init()`:
Replace with `MetaDataLoader.fromUris(name, uris)`.

For each test file, edit imports + the loader-construction lines. Compile after each module.

- [ ] **Step 3: Delete `loader/file/`**

```bash
git rm -r server/java/metadata/src/main/java/com/metaobjects/loader/file/
git rm server/java/metadata/src/test/java/com/metaobjects/loader/file/FileMetaDataLoaderTest.java
```

- [ ] **Step 4: Drop the deprecated `createFromURIs` / `createFromResources` aliases**

In `MetaDataLoader.java`, delete the old `createFromURIs` and `createFromResources` static methods (they were replaced by `fromUris`). `createManual` stays — it's the internal test-only constructor used by the factories.

Update any remaining callers of `createFromURIs` / `createFromResources` to use `fromUris` — recompile the whole reactor:

```bash
cd server/java && mvn clean compile test-compile -q
```

Fix any remaining compile errors.

- [ ] **Step 5: Run full Java test suite**

```bash
cd server/java && mvn test -q
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/java
git commit -m "refactor(java): retire FileMetaDataLoader + loader/file/; migrate to MetaDataLoader factories + Source polymorphism"
```

---

### Task 2.7: Java review gate + merge

- [ ] **Step 1: Dispatch code-reviewer** ("Review the Java loader unification — branch current, against spec docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md")
- [ ] **Step 2: Apply Important findings**
- [ ] **Step 3: Dispatch code-simplifier** ("Simplify the recently-modified Java loader code under server/java/metadata/src/main/java/com/metaobjects/loader/")
- [ ] **Step 4: Re-run `mvn test`**
- [ ] **Step 5: Merge to main** (same FF/merge dance as Phase 1)

---

# Phase 3 — TS port

**Branch:** `worktree-loader-unify-ts`.

---

### Task 3.1: Move `FileSource` from `core/` to `loader/sources/`, add directory + uri + rename in-memory

**Files:**
- Move: `server/typescript/packages/metadata/src/core/file-source.ts` → `server/typescript/packages/metadata/src/loader/sources/file-source.ts`
- Create: `server/typescript/packages/metadata/src/loader/sources/directory-source.ts`
- Create: `server/typescript/packages/metadata/src/loader/sources/uri-source.ts`
- Create: `server/typescript/packages/metadata/src/loader/sources/index.ts`
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-source.ts` (rename `InMemorySource` → `InMemoryStringSource`)

- [ ] **Step 1: Move FileSource**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
mkdir -p server/typescript/packages/metadata/src/loader/sources
git mv server/typescript/packages/metadata/src/core/file-source.ts \
       server/typescript/packages/metadata/src/loader/sources/file-source.ts
```

The file is `~53` lines, no changes needed beyond the new path.

- [ ] **Step 2: Rename `InMemorySource` → `InMemoryStringSource`**

Edit `server/typescript/packages/metadata/src/loader/meta-data-source.ts`:

```typescript
export class InMemoryStringSource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;
  private readonly content: string;

  constructor(content: string, opts?: { id?: string; format?: MetaDataFormat }) {
    this.content = content;
    this.id = opts?.id ?? "<inline>";
    this.format = opts?.format ?? "json";
  }

  async read(): Promise<string> {
    return this.content;
  }
}
```

- [ ] **Step 3: Create `DirectorySource`**

`server/typescript/packages/metadata/src/loader/sources/directory-source.ts`:

```typescript
import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { FileSource } from "./file-source.js";
import type { MetaDataSource } from "../meta-data-source.js";

export interface DirectoryOptions {
  /** Filename patterns to exclude (literal or trailing '*'). */
  exclude?: string[];
  /** Recurse into subdirectories. Default: true. */
  recurse?: boolean;
}

const SUPPORTED = new Set([".json", ".yaml", ".yml"]);

export class DirectorySource {
  constructor(
    public readonly directory: string,
    public readonly opts: DirectoryOptions = {},
  ) {}

  async expand(): Promise<MetaDataSource[]> {
    const recurse = this.opts.recurse ?? true;
    const exclude = this.opts.exclude ?? [];

    const files = await this.collect(this.directory, recurse);
    const filtered = files
      .filter((p) => SUPPORTED.has(extname(p).toLowerCase()))
      .filter((p) => !exclude.some((e) => matches(basename(p), e)));

    filtered.sort();
    return filtered.map((p) => new FileSource(p));
  }

  private async collect(dir: string, recurse: boolean): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recurse) out.push(...await this.collect(full, recurse));
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
    return out;
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function matches(name: string, pattern: string): boolean {
  if (pattern === name) return true;
  if (pattern.startsWith("*") && name.endsWith(pattern.slice(1))) return true;
  if (pattern.endsWith("*") && name.startsWith(pattern.slice(0, -1))) return true;
  return false;
}
```

- [ ] **Step 4: Create `UriSource`**

`server/typescript/packages/metadata/src/loader/sources/uri-source.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import type { MetaDataSource, MetaDataFormat } from "../meta-data-source.js";

export class UriSource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;

  constructor(public readonly uri: string, format?: MetaDataFormat) {
    this.id = uri;
    this.format = format ?? inferFormat(uri);
  }

  async read(): Promise<string> {
    if (this.uri.startsWith("file://")) {
      return readFile(fileURLToPath(this.uri), "utf8");
    }
    if (this.uri.startsWith("http://") || this.uri.startsWith("https://")) {
      const res = await fetch(this.uri);
      if (!res.ok) throw new Error(`UriSource: ${this.uri} -> HTTP ${res.status}`);
      return res.text();
    }
    throw new Error(`UriSource: unsupported scheme on ${this.uri}`);
  }
}

function inferFormat(uri: string): MetaDataFormat {
  const ext = extname(new URL(uri).pathname).toLowerCase();
  return ext === ".yaml" || ext === ".yml" ? "yaml" : "json";
}
```

- [ ] **Step 5: Create sources barrel**

`server/typescript/packages/metadata/src/loader/sources/index.ts`:

```typescript
export { FileSource } from "./file-source.js";
export { DirectorySource } from "./directory-source.js";
export type { DirectoryOptions } from "./directory-source.js";
export { UriSource } from "./uri-source.js";
```

- [ ] **Step 6: Tests for new sources**

Write `server/typescript/packages/metadata/test/loader/sources.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectorySource, FileSource, UriSource } from "../../src/loader/sources/index.js";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";

describe("DirectorySource", () => {
  test("expand sorts ordinally and filters by extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    try {
      await writeFile(join(dir, "b.json"), "{}");
      await writeFile(join(dir, "a.yaml"), "");
      await writeFile(join(dir, "skip.txt"), "x");
      const expanded = await new DirectorySource(dir).expand();
      expect(expanded.map((s) => s.id)).toEqual([
        // ids are full paths (FileSource.id = full path); sort by full path → "a.yaml" < "b.json"
        expect.stringMatching(/a\.yaml$/),
        expect.stringMatching(/b\.json$/),
      ]);
      expect(expanded[0].format).toBe("yaml");
      expect(expanded[1].format).toBe("json");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("InMemoryStringSource", () => {
  test("defaults", async () => {
    const s = new InMemoryStringSource("{}");
    expect(s.id).toBe("<inline>");
    expect(s.format).toBe("json");
    expect(await s.read()).toBe("{}");
  });
  test("yaml format", () => {
    const s = new InMemoryStringSource("x: 1", { format: "yaml" });
    expect(s.format).toBe("yaml");
  });
});
```

Note: the existing `FileSource` already sets `id` to `basename(path)`, not full path. If the test above fails on the path expectation, update assertions to match `id` = basename. (Verify with the existing `FileSource` source.)

Run:

```bash
cd server/typescript && bun test packages/metadata/test/loader/sources.test.ts
```

Expected: PASS (after fixup if any).

- [ ] **Step 7: Commit**

```bash
git add server/typescript
git commit -m "feat(ts): unify loader sources package (FileSource/DirectorySource/UriSource/InMemoryStringSource)"
```

---

### Task 3.2: Fold YAML dispatch into `MetaDataLoader.parseSource`; add static factories

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts`

- [ ] **Step 1: Replace `parseSource` with format-dispatching version**

In `meta-data-loader.ts`, replace the existing `parseSource` (lines ~164–176) with:

```typescript
protected parseSource(
  content: string,
  source: MetaDataSource,
  parseOpts: ParseOptions,
): ParseResult {
  if (source.format === "json") {
    return parseJson(content, parseOpts);
  }
  if (source.format === "yaml") {
    return parseYaml(content, parseOpts);
  }
  throw new Error(
    `MetaDataLoader: unsupported source format "${(source as { format: string }).format}"`,
  );
}
```

Add to the top of the file:

```typescript
import { parseYaml } from "../core/parser-yaml.js";
```

(`parser-yaml.ts` stays at `src/core/` for now — relocate later if it becomes inconvenient.)

- [ ] **Step 2: Add static factories**

After the constructor, before the existing methods, add:

```typescript
  // --- Static factories (the 99% case, cross-language consistent) ---

  static async fromDirectory(
    dir: string,
    opts?: { exclude?: string[]; recurse?: boolean } & LoadOptions,
  ): Promise<LoadResult> {
    const { exclude, recurse, ...loaderOpts } = opts ?? {};
    const sources = await new DirectorySource(dir, { exclude, recurse }).expand();
    return new MetaDataLoader(loaderOpts).load(sources);
  }

  static async fromUris(uris: string[], opts?: LoadOptions): Promise<LoadResult> {
    const sources = uris.map((u) => new UriSource(u));
    return new MetaDataLoader(opts).load(sources);
  }

  static async fromString(
    content: string,
    format: MetaDataFormat,
    opts?: LoadOptions,
  ): Promise<LoadResult> {
    return new MetaDataLoader(opts).load([new InMemoryStringSource(content, { format })]);
  }
```

Add imports at top of file:

```typescript
import { DirectorySource } from "./sources/directory-source.js";
import { UriSource } from "./sources/uri-source.js";
import { InMemoryStringSource } from "./meta-data-source.js";
import type { MetaDataFormat } from "./meta-data-source.js";
```

- [ ] **Step 3: Write factory test**

`server/typescript/packages/metadata/test/loader/factories.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";

describe("MetaDataLoader factories", () => {
  test("fromString loads JSON", async () => {
    const r = await MetaDataLoader.fromString(
      `{"metadata.root":{"package":"x","children":[]}}`,
      "json",
    );
    expect(r.errors).toEqual([]);
  });

  test("fromDirectory loads a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ld-"));
    try {
      await writeFile(join(dir, "meta.tiny.json"),
        `{"metadata.root":{"package":"x","children":[]}}`);
      const r = await MetaDataLoader.fromDirectory(dir);
      expect(r.errors).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("fromString loads YAML", async () => {
    const r = await MetaDataLoader.fromString(
      "metadata.root:\n  package: x\n  children: []\n",
      "yaml",
    );
    expect(r.errors).toEqual([]);
  });
});
```

Run:

```bash
cd server/typescript && bun test packages/metadata/test/loader/factories.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/typescript
git commit -m "feat(ts): MetaDataLoader.fromDirectory/fromUris/fromString + fold YAML dispatch into base"
```

---

### Task 3.3: Add module-level shortcuts `loadDirectory` / `loadUris` / `loadString`

**Files:**
- Modify: `server/typescript/packages/metadata/src/index.ts`

- [ ] **Step 1: Add shortcut exports**

Append to `server/typescript/packages/metadata/src/index.ts`:

```typescript
// --- Module-level shortcuts (delegate to MetaDataLoader.from*) ---
import { MetaDataLoader } from "./loader/meta-data-loader.js";
import type { LoadOptions, LoadResult } from "./loader/meta-data-loader.js";
import type { MetaDataFormat } from "./loader/meta-data-source.js";

export function loadDirectory(
  dir: string,
  opts?: { exclude?: string[]; recurse?: boolean } & LoadOptions,
): Promise<LoadResult> {
  return MetaDataLoader.fromDirectory(dir, opts);
}

export function loadUris(uris: string[], opts?: LoadOptions): Promise<LoadResult> {
  return MetaDataLoader.fromUris(uris, opts);
}

export function loadString(
  content: string,
  format: MetaDataFormat,
  opts?: LoadOptions,
): Promise<LoadResult> {
  return MetaDataLoader.fromString(content, format, opts);
}

export { DirectorySource } from "./loader/sources/directory-source.js";
export type { DirectoryOptions } from "./loader/sources/directory-source.js";
export { FileSource } from "./loader/sources/file-source.js";
export { UriSource } from "./loader/sources/uri-source.js";
export { InMemoryStringSource } from "./loader/meta-data-source.js";
```

- [ ] **Step 2: Test shortcut + barrel re-export**

`server/typescript/packages/metadata/test/loader/shortcuts.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { loadString, FileSource, DirectorySource, InMemoryStringSource } from "../../src/index.js";

describe("module-level shortcuts", () => {
  test("loadString JSON", async () => {
    const r = await loadString(`{"metadata.root":{"package":"x","children":[]}}`, "json");
    expect(r.errors).toEqual([]);
  });

  test("source classes re-exported from root", () => {
    expect(FileSource).toBeDefined();
    expect(DirectorySource).toBeDefined();
    expect(InMemoryStringSource).toBeDefined();
  });
});
```

```bash
cd server/typescript && bun test packages/metadata/test/loader/shortcuts.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/typescript
git commit -m "feat(ts): module-level loadDirectory/loadUris/loadString shortcuts"
```

---

### Task 3.4: Migrate all callers off `FileMetaDataLoader`, delete it

**Files (production + tests):**
Per inventory — ~60 sites across:
- `server/typescript/packages/metadata/src/core/export-json.ts`
- `server/typescript/packages/sdk/src/memory.ts`
- All `server/typescript/packages/metadata/test/**/*.test.ts` that use `FileMetaDataLoader`
- All `server/typescript/packages/codegen-ts*/test/**/*.test.ts` ditto
- `client/web/packages/*/test/**/*.test.ts` (check)

- [ ] **Step 1: Find all callsites**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
grep -rln 'FileMetaDataLoader' server/typescript client/web --include='*.ts' --include='*.tsx'
```

- [ ] **Step 2: Rewrite each pattern**

Pattern A — `new FileMetaDataLoader().loadDirectory(dir)`:
```typescript
const result = await MetaDataLoader.fromDirectory(dir);
```

Pattern B — `new FileMetaDataLoader().loadDirectory(dir, { exclude })`:
```typescript
const result = await MetaDataLoader.fromDirectory(dir, { exclude });
```

Pattern C — `new FileMetaDataLoader().loadFiles([path])`:
```typescript
const result = await new MetaDataLoader().load([new FileSource(path)]);
```

Or the one-shot form if a single path:
```typescript
const result = await new MetaDataLoader().load([new FileSource(path)]);
```

Pattern D — registry override:
```typescript
const result = await MetaDataLoader.fromDirectory(dir, { registry });
```

Pattern E — `loadAndExportJson` (consolidates loader + serializer in `core/export-json.ts`):
Rewrite to use `MetaDataLoader.fromDirectory(dir, opts)` internally; signature unchanged.

Update all imports to pull from `@metaobjectsdev/metadata` root instead of `/core`.

- [ ] **Step 3: Delete `FileMetaDataLoader.ts` and drop from `core/index.ts`**

```bash
git rm server/typescript/packages/metadata/src/core/file-meta-data-loader.ts
```

Edit `server/typescript/packages/metadata/src/core/index.ts` — remove `FileMetaDataLoader` and `FileSource` exports (FileSource is now exported from `loader/sources/`):

```typescript
// Remove these lines:
// export { FileSource } from "./file-source.js";
// export { FileMetaDataLoader } from "./file-meta-data-loader.js";
```

- [ ] **Step 4: Drop `InMemorySource` alias if any consumers still use the old name**

Search:
```bash
grep -rn 'InMemorySource' server/typescript client/web --include='*.ts' --include='*.tsx'
```

For any remaining hits, rewrite to `InMemoryStringSource`.

- [ ] **Step 5: Typecheck + build + test**

```bash
cd /home/doug/Development/metaobjects/.claude/worktrees/wa2-entity-value-representation
bun run --filter '*' typecheck
bun run --filter '*' build
cd server/typescript && bun test
```

Expected: all green (~2123 server tests).

- [ ] **Step 6: Commit**

```bash
git add server/typescript client/web
git commit -m "refactor(ts): retire FileMetaDataLoader; migrate all callers to MetaDataLoader factories + Source polymorphism"
```

---

### Task 3.5: TS review gate + merge

- [ ] **Step 1: Dispatch code-reviewer**
- [ ] **Step 2: Apply Important findings**
- [ ] **Step 3: Dispatch code-simplifier** on `server/typescript/packages/metadata/src/loader/`
- [ ] **Step 4: Re-run `bun test`**
- [ ] **Step 5: Merge to main**

---

# Phase 4 — Python port

**Branch:** `worktree-loader-unify-python`.

---

### Task 4.1: Create `MetaDataSource` ABC + 4 source impls

**Files:**
- Create: `server/python/src/metaobjects/loader/sources/__init__.py`
- Create: `server/python/src/metaobjects/loader/sources/meta_data_source.py`
- Create: `server/python/src/metaobjects/loader/sources/file_source.py`
- Create: `server/python/src/metaobjects/loader/sources/directory_source.py`
- Create: `server/python/src/metaobjects/loader/sources/uri_source.py`
- Test: `server/python/tests/unit/test_sources.py`

- [ ] **Step 1: Write the failing test**

`server/python/tests/unit/test_sources.py`:

```python
from pathlib import Path
import tempfile

from metaobjects.loader.sources import (
    DirectorySource,
    FileSource,
    InMemoryStringSource,
    MetaDataFormat,
    UriSource,
)


def test_file_source_infers_format_from_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    p.write_text("k: v", encoding="utf-8")
    src = FileSource(p)
    assert src.format == MetaDataFormat.YAML
    assert src.id == "x.yaml"
    assert src.read() == "k: v"


def test_file_source_explicit_format_overrides(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_text("k: v", encoding="utf-8")
    src = FileSource(p, format=MetaDataFormat.YAML)
    assert src.format == MetaDataFormat.YAML


def test_in_memory_string_source_defaults() -> None:
    src = InMemoryStringSource("{}")
    assert src.id == "<inline>"
    assert src.format == MetaDataFormat.JSON
    assert src.read() == "{}"


def test_directory_source_expand_sorted_filtered(tmp_path: Path) -> None:
    (tmp_path / "b.json").write_text("{}", encoding="utf-8")
    (tmp_path / "a.yaml").write_text("", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("x", encoding="utf-8")
    expanded = list(DirectorySource(tmp_path).expand())
    assert [s.id for s in expanded] == ["a.yaml", "b.json"]
    assert expanded[0].format == MetaDataFormat.YAML
    assert expanded[1].format == MetaDataFormat.JSON


def test_directory_source_honors_exclude(tmp_path: Path) -> None:
    (tmp_path / "meta.alpha.json").write_text("{}", encoding="utf-8")
    (tmp_path / "meta.beta.json").write_text("{}", encoding="utf-8")
    src = DirectorySource(tmp_path, exclude=["meta.beta.json"])
    expanded = list(src.expand())
    assert [s.id for s in expanded] == ["meta.alpha.json"]
```

- [ ] **Step 2: Verify it fails**

```bash
cd server/python && pytest tests/unit/test_sources.py -v
```

Expected: FAIL — sources package does not exist.

- [ ] **Step 3: Implement the sources package**

`server/python/src/metaobjects/loader/sources/__init__.py`:

```python
"""Polymorphic MetaDataSource implementations."""

from .meta_data_source import InMemoryStringSource, MetaDataFormat, MetaDataSource
from .file_source import FileSource
from .directory_source import DirectorySource
from .uri_source import UriSource

__all__ = [
    "MetaDataFormat",
    "MetaDataSource",
    "InMemoryStringSource",
    "FileSource",
    "DirectorySource",
    "UriSource",
]
```

`server/python/src/metaobjects/loader/sources/meta_data_source.py`:

```python
"""MetaDataSource abstract base + InMemoryStringSource impl."""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum


class MetaDataFormat(str, Enum):
    JSON = "json"
    YAML = "yaml"


class MetaDataSource(ABC):
    """A source of metadata content. Declares identity + format; reads bytes lazily."""

    @property
    @abstractmethod
    def id(self) -> str: ...

    @property
    @abstractmethod
    def format(self) -> MetaDataFormat: ...

    @abstractmethod
    def read(self) -> str: ...


class InMemoryStringSource(MetaDataSource):
    """In-memory string source; no I/O."""

    def __init__(
        self,
        content: str,
        id: str = "<inline>",
        format: MetaDataFormat = MetaDataFormat.JSON,
    ) -> None:
        self._content = content
        self._id = id
        self._format = format

    @property
    def id(self) -> str:
        return self._id

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        return self._content
```

`server/python/src/metaobjects/loader/sources/file_source.py`:

```python
"""Single-file MetaDataSource."""

from __future__ import annotations

from pathlib import Path

from .meta_data_source import MetaDataFormat, MetaDataSource


def _infer_format(path: Path) -> MetaDataFormat:
    suffix = path.suffix.lower()
    if suffix in (".yaml", ".yml"):
        return MetaDataFormat.YAML
    return MetaDataFormat.JSON


class FileSource(MetaDataSource):
    def __init__(self, path: Path | str, format: MetaDataFormat | None = None) -> None:
        self._path = Path(path)
        self._format = format if format is not None else _infer_format(self._path)

    @property
    def path(self) -> Path:
        return self._path

    @property
    def id(self) -> str:
        return self._path.name

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        return self._path.read_text(encoding="utf-8-sig")  # tolerant of UTF-8 BOM
```

`server/python/src/metaobjects/loader/sources/directory_source.py`:

```python
"""Directory expander → list of FileSource."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path

from .file_source import FileSource


_SUPPORTED = (".json", ".yaml", ".yml")


class DirectorySource:
    def __init__(
        self,
        directory: Path | str,
        exclude: Iterable[str] | None = None,
        recurse: bool = True,
    ) -> None:
        self._directory = Path(directory)
        self._exclude = list(exclude or ())
        self._recurse = recurse

    @property
    def directory(self) -> Path:
        return self._directory

    def expand(self) -> Iterator[FileSource]:
        paths = (
            self._directory.rglob("*") if self._recurse else self._directory.iterdir()
        )
        files = [
            p for p in paths
            if p.is_file()
            and p.suffix.lower() in _SUPPORTED
            and p.name not in self._exclude
        ]
        files.sort(key=lambda p: p.name)
        for p in files:
            yield FileSource(p)
```

`server/python/src/metaobjects/loader/sources/uri_source.py`:

```python
"""URI-backed MetaDataSource (file://, http://, https://)."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

from .meta_data_source import MetaDataFormat, MetaDataSource


class UriSource(MetaDataSource):
    def __init__(self, uri: str, format: MetaDataFormat | None = None) -> None:
        self._uri = uri
        self._format = format if format is not None else _infer_format(uri)

    @property
    def id(self) -> str:
        return self._uri

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        parsed = urlparse(self._uri)
        if parsed.scheme == "file":
            return Path(parsed.path).read_text(encoding="utf-8-sig")
        if parsed.scheme in ("http", "https"):
            with urlopen(self._uri) as resp:
                return resp.read().decode("utf-8")
        raise ValueError(f"UriSource: unsupported scheme '{parsed.scheme}' on {self._uri}")


def _infer_format(uri: str) -> MetaDataFormat:
    path = urlparse(uri).path
    suffix = Path(path).suffix.lower()
    if suffix in (".yaml", ".yml"):
        return MetaDataFormat.YAML
    return MetaDataFormat.JSON
```

- [ ] **Step 4: Verify tests pass**

```bash
cd server/python && pytest tests/unit/test_sources.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python
git commit -m "feat(python): add MetaDataSource ABC + FileSource/DirectorySource/UriSource/InMemoryStringSource"
```

---

### Task 4.2: Replace free `load_directory` with `MetaDataLoader` class

**Files:**
- Rewrite: `server/python/src/metaobjects/loader/meta_data_loader.py`
- Modify: `server/python/src/metaobjects/__init__.py`

- [ ] **Step 1: Write the failing test**

`server/python/tests/unit/test_loader_class.py`:

```python
from pathlib import Path
import pytest

from metaobjects.core_types import core_provider
from metaobjects.loader.meta_data_loader import MetaDataLoader
from metaobjects.loader.sources import (
    DirectorySource,
    InMemoryStringSource,
    MetaDataFormat,
)


def test_load_from_directory_source(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(
        '{"metadata.root":{"package":"x","children":[]}}',
        encoding="utf-8",
    )
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load(list(DirectorySource(tmp_path).expand()))
    assert result.errors == []
    assert result.root is not None


def test_load_from_inline_yaml() -> None:
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load([
        InMemoryStringSource(
            "metadata.root:\n  package: x\n  children: []\n",
            format=MetaDataFormat.YAML,
        )
    ])
    assert result.errors == []


def test_from_directory_classmethod(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(
        '{"metadata.root":{"package":"x","children":[]}}',
        encoding="utf-8",
    )
    result = MetaDataLoader.from_directory(tmp_path)
    assert result.errors == []


def test_from_string_classmethod() -> None:
    result = MetaDataLoader.from_string(
        '{"metadata.root":{"package":"x","children":[]}}',
        format=MetaDataFormat.JSON,
    )
    assert result.errors == []
```

- [ ] **Step 2: Run, expect fail**

```bash
cd server/python && pytest tests/unit/test_loader_class.py -v
```

Expected: FAIL.

- [ ] **Step 3: Rewrite `meta_data_loader.py`**

```python
"""MetaDataLoader: source-polymorphic loader."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from metaobjects.error import ErrorCode, MetaError
from metaobjects.loader.merge import merge_roots
from metaobjects.loader.sources import (
    DirectorySource,
    FileSource,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
    UriSource,
)
from metaobjects.loader.validation_passes import run_all_passes
from metaobjects.meta_data import MetaData
from metaobjects.parser import ParseResult, parse_document
from metaobjects.parser_yaml import parse_yaml
from metaobjects.provider import Provider, compose_registry
from metaobjects.type_registry import TypeRegistry


@dataclass
class LoadResult:
    root: MetaData
    errors: list[MetaError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class MetaDataLoader:
    """Source-polymorphic loader: load(sources) → LoadResult."""

    def __init__(self, providers: list[Provider] | None = None) -> None:
        from metaobjects.core_types import core_provider
        self._registry: TypeRegistry = compose_registry(providers or [core_provider])

    @property
    def registry(self) -> TypeRegistry:
        return self._registry

    def load(self, sources: list[MetaDataSource]) -> LoadResult:
        errors: list[MetaError] = []
        warnings: list[str] = []
        parsed: list[ParseResult] = []

        for src in sources:
            pr = self._parse(src, errors)
            if pr is not None:
                parsed.append(pr)
                errors.extend(pr.errors)
                warnings.extend(pr.warnings)

        if not parsed:
            return LoadResult(root=MetaData("metadata", "root"), errors=errors, warnings=warnings)

        root = merge_roots([pr.root for pr in parsed], self._registry)
        run_all_passes(root, self._registry, errors, warnings)
        return LoadResult(root=root, errors=errors, warnings=warnings)

    # --- static factories (the 99% case, cross-language consistent) ---

    @classmethod
    def from_directory(
        cls,
        directory: Path | str,
        providers: list[Provider] | None = None,
        exclude: list[str] | None = None,
        recurse: bool = True,
    ) -> LoadResult:
        loader = cls(providers=providers)
        sources = list(DirectorySource(directory, exclude=exclude, recurse=recurse).expand())
        return loader.load(sources)

    @classmethod
    def from_uris(
        cls,
        uris: list[str],
        providers: list[Provider] | None = None,
    ) -> LoadResult:
        loader = cls(providers=providers)
        return loader.load([UriSource(u) for u in uris])

    @classmethod
    def from_string(
        cls,
        content: str,
        format: MetaDataFormat = MetaDataFormat.JSON,
        providers: list[Provider] | None = None,
    ) -> LoadResult:
        loader = cls(providers=providers)
        return loader.load([InMemoryStringSource(content, format=format)])

    # --- internals ---

    def _parse(self, src: MetaDataSource, errors: list[MetaError]) -> ParseResult | None:
        try:
            text = src.read()
        except OSError as exc:
            errors.append(MetaError.create(
                ErrorCode.ERR_IO,
                f"failed to read source {src.id}: {exc}",
                location=src.id,
            ))
            return None

        if src.format is MetaDataFormat.JSON:
            try:
                raw = json.loads(text)
            except json.JSONDecodeError as exc:
                errors.append(MetaError.create(
                    ErrorCode.ERR_MALFORMED_JSON,
                    f"invalid JSON in {src.id}: {exc.msg}",
                    location=f"{src.id}:{exc.lineno}:{exc.colno}",
                ))
                return None
            return parse_document(raw, self._registry, source=src.id)

        if src.format is MetaDataFormat.YAML:
            return parse_yaml(text, self._registry, source=src.id)

        errors.append(MetaError.create(
            ErrorCode.ERR_IO,
            f"unsupported source format '{src.format}' on {src.id}",
            location=src.id,
        ))
        return None
```

Note: the existing `load_directory` free function is deleted as part of this commit. The package-level shortcut comes in Task 4.3.

- [ ] **Step 4: Run loader tests**

```bash
cd server/python && pytest tests/unit/test_loader_class.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/python
git commit -m "feat(python): MetaDataLoader class with from_directory/from_uris/from_string factories"
```

---

### Task 4.3: Add module-level shortcuts; update package `__init__`

**Files:**
- Modify: `server/python/src/metaobjects/__init__.py`

- [ ] **Step 1: Add public exports**

```python
"""metaobjects — Python implementation of the MetaObjects standard."""

from metaobjects.loader.meta_data_loader import LoadResult, MetaDataLoader
from metaobjects.loader.sources import (
    DirectorySource,
    FileSource,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
    UriSource,
)


def load_directory(directory, providers=None, exclude=None, recurse=True):
    """Module-level shortcut for MetaDataLoader.from_directory."""
    return MetaDataLoader.from_directory(
        directory, providers=providers, exclude=exclude, recurse=recurse,
    )


def load_uris(uris, providers=None):
    """Module-level shortcut for MetaDataLoader.from_uris."""
    return MetaDataLoader.from_uris(uris, providers=providers)


def load_string(content, format=MetaDataFormat.JSON, providers=None):
    """Module-level shortcut for MetaDataLoader.from_string."""
    return MetaDataLoader.from_string(content, format=format, providers=providers)


__all__ = [
    "MetaDataLoader",
    "LoadResult",
    "MetaDataSource",
    "MetaDataFormat",
    "FileSource",
    "DirectorySource",
    "UriSource",
    "InMemoryStringSource",
    "load_directory",
    "load_uris",
    "load_string",
]
```

- [ ] **Step 2: Add a quick shortcut test**

`server/python/tests/unit/test_module_shortcuts.py`:

```python
import metaobjects


def test_module_level_load_string() -> None:
    result = metaobjects.load_string(
        '{"metadata.root":{"package":"x","children":[]}}',
    )
    assert result.errors == []
```

```bash
cd server/python && pytest tests/unit/test_module_shortcuts.py -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/python
git commit -m "feat(python): module-level load_directory/load_uris/load_string shortcuts"
```

---

### Task 4.4: Migrate all existing callers off the old free function

**Callsite inventory (per phase 0 explore):**

- `server/python/tests/conformance/conformance_adapter.py` (2 sites)
- `server/python/tests/unit/test_loader.py` (1 site)
- `server/python/tests/unit/test_loader_bom.py` (3 sites)
- `server/python/tests/unit/test_relationship_referential_actions.py`
- `server/python/tests/unit/test_common_attrs.py`
- `server/python/tests/unit/test_meta_source.py`
- `server/python/tests/unit/test_one_primary_source.py`
- `server/python/tests/unit/test_field_enum.py`
- `server/python/tests/codegen/test_runner.py`
- `server/python/tests/codegen/test_golden.py`

- [ ] **Step 1: Rewrite each callsite**

Pattern (old):
```python
from metaobjects.loader.meta_data_loader import load_directory
result = load_directory(str(input_dir), providers=[core_provider])
```

Pattern (new):
```python
from metaobjects import MetaDataLoader
result = MetaDataLoader.from_directory(input_dir, providers=[core_provider])
```

OR:
```python
import metaobjects
result = metaobjects.load_directory(input_dir, providers=[core_provider])
```

Find sites:
```bash
grep -rln 'load_directory\|from metaobjects.loader.meta_data_loader' server/python --include='*.py'
```

Rewrite each one. Verify no module re-exports a free function named `load_directory` from `metaobjects.loader.meta_data_loader` anymore.

- [ ] **Step 2: Run full python test suite**

```bash
cd server/python && pytest -v
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add server/python
git commit -m "refactor(python): migrate all callers to MetaDataLoader class + module shortcuts"
```

---

### Task 4.5: Python review gate + merge

- [ ] **Step 1: Dispatch code-reviewer**
- [ ] **Step 2: Apply Important findings**
- [ ] **Step 3: Dispatch code-simplifier** on `server/python/src/metaobjects/loader/`
- [ ] **Step 4: Re-run `pytest`**
- [ ] **Step 5: Merge to main**

---

## Cross-port verification (after all 4 ports land)

- [ ] **Step 1: Conformance corpus passes in all 4 ports**

```bash
cd server/typescript && bun test            # ~2123 tests
cd server/java && mvn test                  # full reactor
cd server/csharp && dotnet test
cd server/python && pytest
```

- [ ] **Step 2: Update CLAUDE.md if any wording referenced the old vocabulary**

```bash
grep -rn 'FileMetaDataLoader\|InMemorySource\|URIMetaDataSource\|load_directory' CLAUDE.md docs/ spec/
```

Update any stale references.

- [ ] **Step 3: Final commit + final main merge**

If CLAUDE.md or docs need updates:

```bash
git add CLAUDE.md docs spec
git commit -m "docs: update references to retire FileMetaDataLoader, rename to InMemoryStringSource/UriSource"
```

---

## Self-Review Checklist (run before kicking off Phase 1)

**1. Spec coverage:** All sections of the spec map to tasks above:
- §2 Decision (single loader + Source polymorphism) ← Tasks 1.4, 2.5, 3.2, 4.2
- §3 MetaDataSource contract (id/content/format) ← Tasks 1.1–1.3, 2.1–2.4, 3.1, 4.1
- §4 Loader API (instance + factories) ← Tasks 1.4, 2.5, 3.2, 4.2
- §4 YAML dispatch ← Task 3.2 (TS); already present in Java/C#/Python (incorporated into 4.2)
- §5 Per-port deletions ← Tasks 1.5, 2.6, 3.4, 4.4
- §6 Migration approach: single PR per port, no back-compat ← gating tasks 1.6, 2.7, 3.5, 4.5
- §7 Tier classification respected (LoadResult shape, source roster names match across ports)
- §9 Testing per port present + cross-port verification at end

**2. Placeholder scan:** Searched for "TBD", "TODO", "implement later", "similar to" — none in this plan. Every code step shows real code.

**3. Type consistency:** Source impl names match across ports:
- `FileSource` ✓
- `DirectorySource` ✓
- `UriSource` (C#/Java/Python/TS — Java renames `URIMetaDataSource`) ✓
- `InMemoryStringSource` (TS renames `InMemorySource`; Java renames `InMemoryMetaDataSource`) ✓

Factory method names match per-port idiom:
- C#: `MetaDataLoader.FromDirectory` / `.FromUris` / `.FromString` (PascalCase) ✓
- Java: `MetaDataLoader.fromDirectory` / `.fromUris` / `.fromString` (camelCase) ✓
- TS: `MetaDataLoader.fromDirectory` / `.fromUris` / `.fromString` (camelCase) ✓
- Python: `MetaDataLoader.from_directory` / `.from_uris` / `.from_string` (snake_case) ✓

`MetaDataFormat` values: lowercase string literals in TS/C#/Python ("json"/"yaml"); enum constants in Java (JSON/YAML). Cross-port wire-compatible: both serialize to "json"/"yaml" if ever exposed.

---

## Execution

**Subagent-Driven Development** — controller dispatches a fresh implementer subagent per task, then spec-compliance reviewer + code-quality reviewer between tasks. At the end of each phase, run the explicit code-reviewer + code-simplifier gate per the user's hard rule, then merge to main.
