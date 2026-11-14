// ValidationIssues — the Zod-named code mapping of the 400 validation envelope, per DataAnnotations attribute.

using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Serialization;
using MetaObjects.Codegen.Runtime;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ValidationIssuesTests
{
    public enum Colour { Red, Green }

    public sealed class Doc
    {
        [Required, MaxLength(5)] public string? Name { get; set; }
        [StringLength(8, MinimumLength = 3)] public string? Code { get; set; }
        [MinLength(2)] public string? Tag { get; set; }
        [Range(1, 10)] public int Rank { get; set; }
        [RegularExpression("^[a-z]+$")] public string? Slug { get; set; }
        [EmailAddress] public string? Email { get; set; }
        [JsonPropertyName("wireOnly"), MaxLength(1)] public string? Renamed { get; set; }
        public Colour Shade { get; set; }
        public Guid Ref { get; set; }
        public decimal Amount { get; set; }
    }

    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    private static List<(string Code, string Path)> Run(Doc doc)
    {
        var issues = new ValidationIssues();
        issues.ValidateObject(doc, Web);
        return issues.Issues.Select(i => ((string)i["code"]!, string.Join(".", (List<object>)i["path"]!))).ToList();
    }

    [Fact]
    public void Each_attribute_maps_to_its_zod_code_at_its_wire_path()
    {
        var found = Run(new Doc
        {
            Name = "toolong", Code = "ab", Tag = "x", Rank = 11, Slug = "NOPE", Email = "nope", Renamed = "xx",
        });
        Assert.Contains(("too_big", "name"), found);
        Assert.Contains(("too_small", "code"), found);
        Assert.Contains(("too_small", "tag"), found);
        Assert.Contains(("too_big", "rank"), found);
        Assert.Contains(("invalid_format", "slug"), found);
        Assert.Contains(("invalid_format", "email"), found);
        Assert.Contains(("too_big", "wireOnly"), found);
    }

    [Fact]
    public void Range_below_the_minimum_is_too_small_and_a_long_string_is_too_big()
    {
        Assert.Contains(("too_small", "rank"), Run(new Doc { Name = "a", Rank = 0 }));
        Assert.Contains(("too_big", "code"), Run(new Doc { Name = "a", Rank = 1, Code = "123456789" }));
    }

    [Fact]
    public void A_missing_required_value_is_invalid_type_and_is_listed_with_every_other_issue()
    {
        var found = Run(new Doc { Name = null, Rank = 1, Tag = "x" });
        Assert.Contains(("invalid_type", "name"), found);
        Assert.Contains(("too_small", "tag"), found);
    }

    [Fact]
    public void A_valid_object_records_nothing() => Assert.Empty(Run(new Doc { Name = "ok", Rank = 5 }));

    [Fact]
    public void A_type_error_at_one_path_is_recorded_once()
    {
        var issues = new ValidationIssues();
        issues.AddRequired("name");
        issues.Add("invalid_type", "expected a string", "name");
        Assert.Equal(1, issues.Count);
    }

    // The shape a generated entity gives a @required readOnly field: [Required] and a PRIVATE setter, so
    // a create body can never bind it and it is null on every create.
    public sealed class Member
    {
        [Required, MaxLength(10)] public string? Title { get; set; }
        [Required, MaxLength(20)] public string? Role { get; private set; }
    }

    [Fact]
    public void A_create_body_is_not_held_to_a_required_rule_on_a_member_it_cannot_set()
    {
        // Oracle: the client cannot set Role, so its [Required] cannot be what makes a create a 400
        // (else the entity could never be created); every other member is still validated.
        var issues = new ValidationIssues();
        Assert.True(issues.ValidateObjectExcept(new Member { Title = "ok" }, Web, ["Role"]));
        Assert.Equal(0, issues.Count);

        var missingTitle = new ValidationIssues();
        Assert.False(missingTitle.ValidateObjectExcept(new Member(), Web, ["Role"]));
        Assert.Equal(1, missingTitle.Count);

        // Without the exception the same object fails on Role: the plain path is unchanged.
        var plain = new ValidationIssues();
        Assert.False(plain.ValidateObject(new Member { Title = "ok" }, Web));
        Assert.Equal(1, plain.Count);
    }

    [Fact]
    public void Two_distinct_failures_of_one_rule_kind_on_one_field_are_both_recorded()
    {
        var issues = new ValidationIssues();
        issues.Add("custom", "must start with a letter", "code");
        issues.Add("custom", "must not contain spaces", "code");
        issues.Add("custom", "must start with a letter", "code");
        Assert.Equal(2, issues.Count);
    }

    private static (string Code, string Path) Json(string body)
    {
        var issues = new ValidationIssues();
        try { JsonSerializer.Deserialize<Doc>(body, Web); Assert.Fail("expected a JsonException"); }
        catch (JsonException e) { issues.AddJson(e, typeof(Doc)); }
        var i = Assert.Single(issues.Issues);
        return ((string)i["code"]!, string.Join(".", (List<object>)i["path"]!));
    }

    [Fact]
    public void A_value_that_cannot_be_read_is_listed_at_its_wire_path()
    {
        Assert.Equal(("invalid_type", "rank"), Json("{\"rank\":\"abc\"}"));
        Assert.Equal(("invalid_format", "ref"), Json("{\"ref\":\"not-a-guid\"}"));
        Assert.Equal(("invalid_value", "shade"), Json("{\"shade\":\"Blue\"}"));
    }

    [Fact]
    public void An_unreadable_body_has_an_empty_path()
    {
        var issues = new ValidationIssues();
        issues.Add("invalid_type", "x", []);
        Assert.Empty((List<object>)issues.Issues[0]["path"]!);
    }
}
