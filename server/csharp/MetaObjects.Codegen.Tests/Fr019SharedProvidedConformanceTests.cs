using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port FR-019 conformance (C#). Loads the shared fixture
/// <c>fixtures/codegen-conformance/shared-provided-enum/input/meta.json</c> and asserts the two
/// FR-019 behaviors (ADR-0026): shared materialization (<c>Priority</c> emitted ONCE, both
/// entities reference it) and <c>@provided</c> (<c>Currency</c> not materialized; referenced at
/// the configured namespace; a missing namespace is a codegen-time error).
/// </summary>
public class Fr019SharedProvidedConformanceTests
{
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static MetaRoot LoadFixture()
    {
        var dir = Path.Combine(LocateRepoRoot(), "fixtures", "codegen-conformance", "shared-provided-enum", "input");
        var load = MetaDataLoader.FromDirectory(dir);
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Ctx(MetaRoot root, string? providedNs = null) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen", ProvidedEnumNamespace = providedNs },
    };

    [Fact]
    public void Shared_abstract_enum_is_materialized_once_and_referenced_by_both_entities()
    {
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();

        var enums = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum Priority { LOW, MEDIUM, HIGH }", enums.Content);
        // Exactly one declaration across the whole output.
        var decls = files.Sum(f => Regex.Matches(f.Content, @"public enum Priority\b").Count);
        Assert.Equal(1, decls);

        foreach (var path in new[] { "Ticket.g.cs", "Order.g.cs" })
        {
            var ef = Assert.Single(files, f => f.Path == path);
            Assert.DoesNotContain("public enum Priority", ef.Content);
            Assert.Contains("public Priority? Priority", ef.Content);
        }
    }

    [Fact]
    public void Multi_hop_enum_extends_still_resolves_to_the_shared_enum()
    {
        // Task.urgency extends Ticket.priority, which extends the shared abstract Priority
        // (two hops); Task.importance extends Ticket.severity, same chain. Task ALSO carries
        // Task.phase/Task.weight, which declare their own @values/@intValueMap and so keep
        // their own per-object nested enum (rule (b)) — the fixture now exercises both in one
        // object, so the assertion below is scoped to the SHARED type, not "any nested enum".
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();
        var task = Assert.Single(files, f => f.Path == "Task.g.cs");
        Assert.DoesNotContain("public enum Priority", task.Content);
        Assert.Contains("public Priority? Urgency", task.Content);
        Assert.Contains("public Priority? Importance", task.Content);
        // The negatives: own @values / own @intValueMap stop resolution, so these stay inline.
        Assert.Contains("public enum TaskPhase", task.Content);
        Assert.Contains("public enum TaskWeight", task.Content);
    }

    [Fact]
    public void Provided_enum_is_not_materialized_and_referenced_at_the_configured_namespace()
    {
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();

        // Nothing emitted for the provided Currency type.
        Assert.All(files, f => Assert.DoesNotContain("public enum Currency", f.Content));

        var ticket = Assert.Single(files, f => f.Path == "Ticket.g.cs");
        Assert.Contains("public Acme.External.Currency? Currency", ticket.Content);
    }

    [Fact]
    public void Provided_enum_with_no_namespace_config_is_a_codegen_error_naming_the_enum()
    {
        var ex = Assert.ThrowsAny<System.Exception>(() =>
            new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: null)).ToList());
        Assert.Contains("Currency", ex.Message);
    }

    // ── Decision table (#246/FR-019 chain rule) ──
    //
    // For every object-hosted field.enum in the fixture, compute the SAME decision the
    // generators use — Fr019SharedEnum.ResolveSharedEnumDecl (the resolved declaration, or
    // null for inline) + Fr019SharedEnum.SharedEnumForField (its @provided-ness) — keyed
    // `<package>::<Object>.<field>`, and assert exact equality (no missing key, no extra
    // key) against the shared fixture's expected-enum-types.json. The chain rule is a
    // walk-order-sensitive decision (nearest shared declaration wins; an own @values/
    // @intValueMap partway up stops it), so a table beats one assertion per case.

    private static JsonDocument LoadExpectedEnumTypes()
    {
        var path = Path.Combine(
            LocateRepoRoot(), "fixtures", "codegen-conformance", "shared-provided-enum", "expected-enum-types.json");
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    private static (string? Shared, bool Provided) Decide(MetaField field)
    {
        var decl = Fr019SharedEnum.ResolveSharedEnumDecl(field);
        var provided = decl is not null && (Fr019SharedEnum.SharedEnumForField(field)?.Provided ?? false);
        return (decl?.ResolutionKey(), provided);
    }

    [Fact]
    public void Decision_table_matches_the_shared_fixture_exactly()
    {
        var root = LoadFixture();
        using var expected = LoadExpectedEnumTypes();
        var expectedFields = expected.RootElement.GetProperty("fields");

        var actual = new Dictionary<string, (string? Shared, bool Provided)>(System.StringComparer.Ordinal);
        foreach (var obj in root.Objects())
            foreach (var field in obj.Fields())
            {
                if (field.SubType != FIELD_SUBTYPE_ENUM) continue;
                actual[$"{obj.ResolutionKey()}.{field.Name}"] = Decide(field);
            }

        var expectedKeys = new HashSet<string>(
            expectedFields.EnumerateObject().Select(p => p.Name), System.StringComparer.Ordinal);
        var missing = expectedKeys.Except(actual.Keys).ToList();
        var extra = actual.Keys.Except(expectedKeys).ToList();
        Assert.Empty(missing);
        Assert.Empty(extra);

        foreach (var prop in expectedFields.EnumerateObject())
        {
            var sharedEl = prop.Value.GetProperty("shared");
            string? expectedShared = sharedEl.ValueKind == JsonValueKind.Null ? null : sharedEl.GetString();
            var expectedProvided = prop.Value.GetProperty("provided").GetBoolean();
            var (actualShared, actualProvided) = actual[prop.Name];
            Assert.Equal(expectedShared, actualShared);
            Assert.Equal(expectedProvided, actualProvided);
        }

        var expectedMaterialized = expected.RootElement.GetProperty("materialized")
            .EnumerateArray().Select(e => e.GetString()!).ToList();
        var actualMaterialized = Fr019SharedEnum.MaterializedSharedEnums(root)
            .Select(e => e.Name).OrderBy(n => n, System.StringComparer.Ordinal).ToList();
        Assert.Equal(expectedMaterialized, actualMaterialized);
    }

    [Fact]
    public void Generated_output_covers_every_multi_hop_and_negative_case_in_the_decision_table()
    {
        var files = new EntityGenerator().Generate(Ctx(LoadFixture(), providedNs: "Acme.External")).ToList();

        // Priority (and its sibling chained declaration Money) are each emitted exactly
        // once, no matter how many fields across how many hops consume them.
        foreach (var name in new[] { "Priority", "Money" })
        {
            var decls = files.Sum(f => Regex.Matches(f.Content, $@"public enum {name}\b").Count);
            Assert.Equal(1, decls);
        }

        // Multi-hop consumers reference the shared Priority type and nest nothing.
        var task = Assert.Single(files, f => f.Path == "Task.g.cs");
        Assert.Contains("public Priority? Importance", task.Content); // Task.importance -> Ticket.severity -> Priority

        var subtask = Assert.Single(files, f => f.Path == "Subtask.g.cs");
        Assert.Contains("public Priority? Rank", subtask.Content); // Subtask.rank: three hops to Priority
        Assert.DoesNotContain("public enum Priority", subtask.Content);

        var ticketSummary = Assert.Single(files, f => f.Path == "TicketSummary.g.cs"); // projection, view source
        Assert.Contains("public Priority? Level", ticketSummary.Content);
        Assert.DoesNotContain("public enum", ticketSummary.Content);

        var ticketBadge = Assert.Single(files, f => f.Path == "TicketBadge.g.cs"); // value object
        Assert.Contains("public Priority? Badge", ticketBadge.Content);
        Assert.DoesNotContain("public enum", ticketBadge.Content);

        // Refund: two fields whose immediate supers are same-named fields of different
        // objects, resolving to two different shared declarations.
        var refund = Assert.Single(files, f => f.Path == "Refund.g.cs");
        Assert.Contains("public Priority? TicketTier", refund.Content);   // Refund.ticketTier -> Ticket.tier -> Priority
        Assert.Contains("public Money? InvoiceTier", refund.Content);    // Refund.invoiceTier -> Invoice.tier -> Money
        Assert.Contains("public Money? Unit", refund.Content);           // Refund.unit -> Invoice.money -> Money (materialized)
        Assert.Contains("public Acme.External.Currency? Tender", refund.Content); // @provided, never materialized
        Assert.DoesNotContain("public enum Currency", refund.Content);

        // Negatives: an own @values / own @intValueMap partway up the chain stops sharing,
        // so these keep their per-object inline nested enum.
        Assert.Contains("public enum TaskPhase", task.Content);
        Assert.Contains("public enum TaskWeight", task.Content);
        Assert.Contains("public enum SubtaskPhase", subtask.Content);
        Assert.Contains("public enum SubtaskWeight", subtask.Content);
        Assert.Contains("public enum RefundOrderStatus", refund.Content);
    }

    [Fact]
    public void A_run_narrowed_to_only_the_projection_still_materializes_the_shared_enum_it_consumes()
    {
        var root = LoadFixture();
        var narrowed = root.Objects().Where(o => o.Name == "TicketSummary").ToList();
        var ctx = new GenContext
        {
            Entities = narrowed,
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen", ProvidedEnumNamespace = "Acme.External" },
        };

        var files = new EntityGenerator().Generate(ctx).ToList();
        var enums = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum Priority { LOW, MEDIUM, HIGH }", enums.Content);
    }
}
