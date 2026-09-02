using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// ADR-0021 D3 — the stable-name generator registry. Mirrors the TS reference
/// (server/typescript/packages/codegen-ts/test): every C# generator is registered
/// under a cross-port-consistent stable name, discoverable, and selectable. The
/// five generators the CLI previously omitted (render-helper, extractor,
/// output-prompt, filter-allowlist, template) must all be present + buildable.
/// </summary>
public sealed class GeneratorRegistryTests
{
    // The cross-port stable-name contract (TS generator-registry.ts), restricted to
    // the concepts C# implements, plus the C#-specific db-context.
    private static readonly string[] ExpectedNames =
    [
        "entity", "db-context", "routes", "payload", "output-parser", "extractor",
        "output-prompt", "render-helper", "filter-allowlist", "template",
        // FR-015 — per-entity callable wrapper (storedProc / tableFunction).
        "callable",
        // Program A / §A5 — per-object physical database name constants.
        "names",
    ];

    [Fact]
    public void Registry_contains_all_expected_generators_with_stable_names()
    {
        Assert.Equal(ExpectedNames.Length, GeneratorRegistry.Entries.Count);
        foreach (var name in ExpectedNames)
            Assert.True(GeneratorRegistry.Entries.ContainsKey(name), $"missing stable name: {name}");
    }

    [Fact]
    public void Every_entry_has_a_non_empty_description_and_matching_name()
    {
        foreach (var (key, entry) in GeneratorRegistry.Entries)
        {
            Assert.Equal(key, entry.Name);
            Assert.False(string.IsNullOrWhiteSpace(entry.Description), $"empty description: {key}");
            Assert.DoesNotContain('\n', entry.Description);
        }
    }

    [Fact]
    public void Every_factory_constructs_without_throwing_for_list()
    {
        // `--list` constructs every entry with an empty build context — none may throw.
        foreach (var entry in GeneratorRegistry.List())
        {
            var gen = entry.Factory(new GeneratorBuildContext());
            Assert.NotNull(gen);
            Assert.False(string.IsNullOrWhiteSpace(gen.Name));
        }
    }

    [Fact]
    public void List_returns_all_entries_native_first_alphabetical_within_tier()
    {
        var list = GeneratorRegistry.List();
        Assert.Equal(GeneratorRegistry.Entries.Count, list.Count);
        var native = list.Where(e => e.Tier == GeneratorTier.Native).Select(e => e.Name).ToList();
        Assert.Equal(native.OrderBy(n => n, StringComparer.Ordinal).ToList(), native);
    }

    [Fact]
    public void Previously_omitted_generators_are_present_and_buildable()
    {
        foreach (var name in new[] { "render-helper", "extractor", "output-prompt", "filter-allowlist", "template" })
        {
            var entry = GeneratorRegistry.Get(name);
            Assert.NotNull(entry);
            Assert.NotNull(entry!.Factory(new GeneratorBuildContext()));
        }
    }

    [Fact]
    public void Resolve_builds_generators_in_requested_order()
    {
        var gens = GeneratorRegistry.Resolve(["routes", "entity"]);
        Assert.Equal(2, gens.Count);
        Assert.Equal("routes-generator", gens[0].Name);
        Assert.Equal("entity-generator", gens[1].Name);
    }

    [Fact]
    public void Resolve_throws_a_helpful_message_on_unknown_name()
    {
        var ex = Assert.Throws<ArgumentException>(() => GeneratorRegistry.Resolve(["no-such-gen"]));
        Assert.Contains("no-such-gen", ex.Message);
        Assert.Contains("--list", ex.Message);
    }

    [Fact]
    public void Render_helper_respects_supplied_template_root()
    {
        var root = Path.Combine(Path.GetTempPath(), "grt_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var gen = GeneratorRegistry.Resolve(["render-helper"], new GeneratorBuildContext(root))[0];
            Assert.Equal("render-helper-generator", gen.Name);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
