// The per-root top-level index behind reference resolution (TopLevelIndex.cs).
//
// Two contracts:
//   1. LINEAR. Resolving a reference does not walk every top-level object. Asserted by counting
//      work (ResolutionKey calls, index builds), never by wall-clock, over 1x, 5x and 10x
//      generated models.
//   2. NEVER STALE. A lookup after the root's top-level nodes changed (a node added, a node
//      re-keyed by a package change, a later source merged in) sees the change.

using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class TopLevelIndexTests
{
    private static readonly string Fitness = File.ReadAllText(Path.Combine(
        CorpusRoot.Path, "..", "persistence-conformance", "canonical", "meta.fitness.json"));

    /// <summary>N renamed copies of the fitness model, one source each.</summary>
    private static List<IMetaDataSource> Sources(int copies) =>
        Enumerable.Range(0, copies)
            .Select(i => (IMetaDataSource)new InMemoryStringSource(
                ReplaceFirst(Fitness, "\"package\": \"fitness\"", $"\"package\": \"fitness_x{i:00}\""),
                id: $"fitness_x{i:00}.json"))
            .ToList();

    private static string ReplaceFirst(string text, string find, string with)
    {
        int at = text.IndexOf(find, StringComparison.Ordinal);
        return text[..at] + with + text[(at + find.Length)..];
    }

    /// <summary>Load N copies, counting every ResolutionKey call and index rebuild.</summary>
    private static (int TopLevel, int KeyCalls, int Rebuilds) Measure(int copies)
    {
        int calls = 0;
        int rebuildsBefore = TopLevelIndex.Rebuilds;
        MetaData.ResolutionKeyProbe = () => calls++;
        try
        {
            var result = new MetaDataLoader().Load(Sources(copies));
            Assert.Empty(result.Errors);
            return (result.Root.Children().Count, calls, TopLevelIndex.Rebuilds - rebuildsBefore);
        }
        finally
        {
            MetaData.ResolutionKeyProbe = null;
        }
    }

    [Fact]
    public void ResolutionKey_calls_per_top_level_node_do_not_grow_with_the_model()
    {
        var (n1, c1, _) = Measure(1);
        var (n5, c5, _) = Measure(5);
        var (n10, c10, _) = Measure(10);
        double per1 = (double)c1 / n1, per5 = (double)c5 / n5, per10 = (double)c10 / n10;

        // A scan-per-reference makes this ratio grow with the model (about 10x between 1x and 10x);
        // the index keeps it flat. 1.5 leaves room for fixed per-load work.
        Assert.True(per5 < per1 * 1.5, $"per-node key calls grew: 1x={per1:F1} 5x={per5:F1}");
        Assert.True(per10 < per1 * 1.5, $"per-node key calls grew: 1x={per1:F1} 10x={per10:F1}");
        // And bounded in absolute terms: a handful of key builds per top-level node, not one per
        // top-level node per reference.
        Assert.True(per10 < 40, $"per-node key calls at 10x: {per10:F1}");
    }

    [Fact]
    public void Index_rebuilds_per_load_do_not_grow_with_the_model()
    {
        var (_, _, r1) = Measure(1);
        var (n10, _, r10) = Measure(10);
        // Appends are absorbed incrementally, so a rebuild happens only when the root's keys change;
        // a load must not rebuild once per top-level node.
        Assert.True(r10 <= r1 + 2, $"rebuilds 1x={r1} 10x={r10}");
        Assert.True(r10 < n10 / 4, $"rebuilds {r10} for {n10} top-level nodes");
    }

    private static MetaRoot NewRoot() => new(new TypeId("metadata", "root"), "");

    private static MetaObject Entity(string name, string? package = null)
    {
        var o = new MetaObject(new TypeId("object", "entity"), name);
        if (package is not null) o.SetPackage(package);
        return o;
    }

    private static MetaData? Resolve(MetaRoot root, string reference, string referrerPkg = "") =>
        NamingRefs.ResolveObjectRef(root, reference, referrerPkg);

    [Fact]
    public void A_node_added_after_a_lookup_is_found_by_the_next_lookup()
    {
        var root = NewRoot();
        var a = Entity("A");
        root.AddChild(a);
        Assert.Same(a, Resolve(root, "A"));
        Assert.Null(Resolve(root, "B"));
        var b = Entity("B");
        root.AddChild(b);
        Assert.Same(b, Resolve(root, "B"));
        Assert.Same(a, Resolve(root, "A"));
    }

    [Fact]
    public void First_match_still_wins_when_a_later_node_has_the_same_key()
    {
        var root = NewRoot();
        var first = Entity("Dup");
        root.AddChild(first);
        Assert.Same(first, Resolve(root, "Dup"));
        root.AddChild(Entity("Dup"));
        Assert.Same(first, Resolve(root, "Dup"));
    }

    [Fact]
    public void SetPackage_on_a_top_level_node_re_keys_it()
    {
        var root = NewRoot();
        var a = Entity("A", "p");
        root.AddChild(a);
        Assert.Same(a, Resolve(root, "p::A"));
        a.SetPackage("q");
        Assert.Null(Resolve(root, "p::A"));
        Assert.Same(a, Resolve(root, "q::A"));
    }

    [Fact]
    public void SetFileDefaultPackage_re_keys_a_package_less_top_level_node()
    {
        var root = NewRoot();
        var a = Entity("A");
        root.AddChild(a);
        Assert.Same(a, Resolve(root, "A"));
        a.SetFileDefaultPackage("r");
        Assert.Null(Resolve(root, "A"));
        Assert.Same(a, Resolve(root, "r::A"));
    }

    [Fact]
    public void A_change_to_the_roots_package_re_keys_its_package_less_children()
    {
        var root = NewRoot();
        var a = Entity("A");
        root.AddChild(a);
        Assert.Same(a, Resolve(root, "A"));
        root.SetPackage("rootpkg"); // a child with no package of its own falls through to it
        Assert.Null(Resolve(root, "A"));
        Assert.Same(a, Resolve(root, "rootpkg::A"));
    }

    [Fact]
    public void A_bare_reference_falls_back_from_the_referrer_package_to_the_root_level_after_a_change()
    {
        var root = NewRoot();
        var rootLevel = Entity("Thing");
        root.AddChild(rootLevel);
        Assert.Same(rootLevel, Resolve(root, "Thing", "pkg"));
        var local = Entity("Thing", "pkg");
        root.AddChild(local);
        Assert.Same(local, Resolve(root, "Thing", "pkg"));
        local.SetPackage("other");
        Assert.Same(rootLevel, Resolve(root, "Thing", "pkg"));
    }

    [Fact]
    public void A_source_merged_in_later_contributes_its_objects()
    {
        var sources = Sources(2);
        var one = new MetaDataLoader().Load([sources[0]]);
        Assert.Null(Resolve(one.Root, "fitness_x01::Program"));
        var both = new MetaDataLoader().Load(Sources(2));
        Assert.Empty(both.Errors);
        Assert.NotNull(Resolve(both.Root, "fitness_x01::Program"));
        Assert.NotNull(Resolve(both.Root, "fitness_x00::Program"));
    }
}
