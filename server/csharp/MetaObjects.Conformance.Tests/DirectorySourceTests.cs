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
    public void Expand_Excludes_PendingDir_AtAnyDepth()
    {
        // Mirrors TypeScript's PENDING_DIR exclusion (metadata-files.ts) — a draft
        // entity under _pending/ must be invisible to codegen, not merely a file
        // that happens to be NAMED "_pending". Before this fix, only TypeScript
        // knew about this directory; a draft would generate a live table under
        // `dotnet meta gen`.
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

            var src = new DirectorySource(dir);
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
