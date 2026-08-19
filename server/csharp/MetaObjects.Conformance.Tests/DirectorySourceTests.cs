using System;
using System.IO;
using System.Linq;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class DirectorySourceTests
{
    [Fact]
    public void Expand_ReturnsFileSourcesSortedByOrdinalName()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
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
    public void Expand_ExcludePending_IsOffByDefault()
    {
        // Loader-level default is OFF (matches TS's loader-level DirectorySource,
        // which has no _pending concept at all) — only the CLI-facing
        // SourceResolver turns it on. An app embedding `new DirectorySource(dir)`
        // directly must see every file, _pending/ included.
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.live.json"), "{}");
            Directory.CreateDirectory(Path.Combine(dir, "_pending"));
            File.WriteAllText(Path.Combine(dir, "_pending", "meta.draft.json"), "{}");

            var src = new DirectorySource(dir);
            var expanded = src.Expand().ToList();

            Assert.Equal(2, expanded.Count);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Expand_Excludes_PendingDir_AtAnyDepth_WhenOptedIn()
    {
        // Mirrors TypeScript's PENDING_DIR exclusion (metadata-files.ts) — a draft
        // entity under _pending/ must be invisible to codegen, not merely a file
        // that happens to be NAMED "_pending". SourceResolver (the CLI-facing
        // caller) opts in via ExcludePending = true; this test exercises the
        // option directly.
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.live.json"), "{}");
            Directory.CreateDirectory(Path.Combine(dir, "_pending"));
            File.WriteAllText(Path.Combine(dir, "_pending", "meta.draft.json"), "{}");
            // Nested: _pending/ excluded at ANY depth, not just top-level.
            Directory.CreateDirectory(Path.Combine(dir, "nested", "_pending"));
            File.WriteAllText(Path.Combine(dir, "nested", "_pending", "meta.deep-draft.json"), "{}");

            var src = new DirectorySource(dir, new DirectorySource.Options { ExcludePending = true });
            var expanded = src.Expand().ToList();

            Assert.Single(expanded);
            Assert.Equal("meta.live.json", expanded[0].Id);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Expand_HonorsExcludeGlobs()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.alpha.json"), "{}");
            File.WriteAllText(Path.Combine(dir, "meta.beta.json"), "{}");

            var src = new DirectorySource(dir, new DirectorySource.Options
            {
                Exclude = new[] { "meta.beta.json" },
            });
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
