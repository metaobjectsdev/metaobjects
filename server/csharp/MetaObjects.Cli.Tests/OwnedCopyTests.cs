// ADR-0034 Amendment 3 — eject. `OwnedCopy` answers "how does what's on disk at
// codegen/generators/<file> compare to the reference `dotnet meta eject` would write
// today" — the staleness report `dotnet meta gen --list` prints per entry. Line-
// multiset comparison, the same shape as the Python/TS ports (see
// server/python/src/metaobjects/codegen/eject.py's owned_status, and
// server/typescript/packages/cli/src/lib/owned-copy.ts): "behind" counts reference
// lines the copy lacks, "of your own" counts copy lines the reference lacks.

using MetaObjects.Cli;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class OwnedCopyTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-owned-" + Guid.NewGuid().ToString("N"));

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Compare_identical_text_is_identical()
    {
        var cmp = OwnedCopy.Compare("a\nb\nc\n", "a\nb\nc\n");
        Assert.Equal(OwnedCopy.Verdict.Identical, cmp.Verdict);
        Assert.Equal(0, cmp.Behind);
        Assert.Equal(0, cmp.OfYourOwn);
    }

    [Fact]
    public void Compare_is_blind_to_blank_lines_and_line_order()
    {
        // Line-multiset, not a sequence diff — matches the Python port exactly (it is
        // NOT formatter-canonicalized like TS's Biome-based comparison).
        var cmp = OwnedCopy.Compare("b\n\na\n\nc\n", "a\nb\nc\n");
        Assert.Equal(OwnedCopy.Verdict.Identical, cmp.Verdict);
    }

    [Fact]
    public void Compare_counts_behind_and_of_your_own_separately()
    {
        // reference has "c" (a copy lacks it -> behind); copy has "d" (own edit -> of your own).
        var cmp = OwnedCopy.Compare(owned: "a\nb\nd\n", reference: "a\nb\nc\n");
        Assert.Equal(OwnedCopy.Verdict.Differs, cmp.Verdict);
        Assert.Equal(1, cmp.Behind);
        Assert.Equal(1, cmp.OfYourOwn);
    }

    [Fact]
    public void Status_is_null_when_nothing_is_owned()
    {
        var entry = GeneratorRegistry.Get("entity")!;
        Assert.Null(OwnedCopy.Status(_tmp, entry));
    }

    [Fact]
    public void Status_is_identical_for_a_freshly_ejected_unmodified_copy()
    {
        var entry = GeneratorRegistry.Get("entity")!;
        var dir = Path.Combine(_tmp, "codegen", "generators");
        Directory.CreateDirectory(dir);
        var rewritten = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource("entity")!);
        File.WriteAllText(Path.Combine(dir, entry.SourceFileName!), rewritten);

        Assert.Equal("identical", OwnedCopy.Status(_tmp, entry));
    }

    [Fact]
    public void Status_reports_differs_after_a_local_edit()
    {
        var entry = GeneratorRegistry.Get("entity")!;
        var dir = Path.Combine(_tmp, "codegen", "generators");
        Directory.CreateDirectory(dir);
        var rewritten = EjectableGenerators.RewriteForEject(EjectableGenerators.ReadSource("entity")!);
        File.WriteAllText(Path.Combine(dir, entry.SourceFileName!), rewritten + "\n// my own line\n");

        var status = OwnedCopy.Status(_tmp, entry);
        Assert.NotNull(status);
        Assert.StartsWith("DIFFERS:", status);
        Assert.Contains("of your own", status);
    }

    [Fact]
    public void Status_is_null_for_a_non_ejectable_entry()
    {
        var entry = GeneratorRegistry.Get("template")!;
        Assert.Null(OwnedCopy.Status(_tmp, entry));
    }
}
