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

    /// <summary>
    /// The shared corpus (`a-symlink-cycle-is-an-error`) can only pin THAT a cycle
    /// raises, because on Linux the kernel's own ELOOP makes an unguarded walk raise
    /// eventually too. These two pin what it cannot: that the raise happens on REVISIT,
    /// and that it distinguishes a cycle from a diamond.
    /// </summary>
    [Fact]
    public void Expand_RaisesOnRevisit_NotAtTheKernelsSymlinkDepthLimit()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.a.json"), "{}");
            Directory.CreateSymbolicLink(Path.Combine(dir, "loop"), dir);

            var ex = Assert.Throws<IOException>(() => new DirectorySource(dir).Expand().ToList());
            Assert.Contains("symlink loop detected", ex.Message);

            // Immediacy: the message names the FIRST revisit. Before the guard,
            // Directory.EnumerateFiles(..., AllDirectories) swallowed the kernel's ELOOP
            // (EnumerationOptions.IgnoreInaccessible) and returned ~40 phantom copies of
            // meta.a.json with no error at all — so asserting only "it threw" would have
            // been satisfied by a walk that had already descended 40 levels.
            Assert.Contains(Path.Combine(dir, "loop"), ex.Message);
            Assert.DoesNotContain(Path.Combine("loop", "loop"), ex.Message);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Expand_FollowsADiamond_WhichIsNotACycle()
    {
        string dir = Path.Combine(Path.GetTempPath(), "ds_" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        try
        {
            // shared/ is reachable twice — via one/ and via two/ — but never from
            // itself. The ancestor set must therefore be per-BRANCH: a set shared
            // across siblings would see the second arrival as a revisit and reject a
            // perfectly valid tree.
            var shared = Path.Combine(dir, "shared");
            Directory.CreateDirectory(shared);
            File.WriteAllText(Path.Combine(shared, "meta.shared.json"), "{}");
            Directory.CreateDirectory(Path.Combine(dir, "one"));
            Directory.CreateDirectory(Path.Combine(dir, "two"));
            Directory.CreateSymbolicLink(Path.Combine(dir, "one", "link"), shared);
            Directory.CreateSymbolicLink(Path.Combine(dir, "two", "link"), shared);

            // One real file, reached by three distinct paths. Compared on FilePath, not
            // Id — Id is the bare filename, so all three share it and a distinctness
            // check there would pass on a single result just as happily.
            var paths = new DirectorySource(dir).Expand().Select(f => f.FilePath).ToList();

            Assert.Equal(3, paths.Count);
            Assert.Equal(3, paths.Distinct().Count());
            Assert.Contains(Path.Combine(dir, "one", "link", "meta.shared.json"), paths);
            Assert.Contains(Path.Combine(dir, "two", "link", "meta.shared.json"), paths);
            Assert.Contains(Path.Combine(shared, "meta.shared.json"), paths);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
