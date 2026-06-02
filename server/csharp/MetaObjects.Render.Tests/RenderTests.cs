using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Core render-engine unit tests, mirroring the engine block of
/// typescript/packages/render/test/render.test.ts. (The verify-on-resolve guard
/// tests are deferred to Phase 3 with the verify port.)
/// </summary>
public class RenderTests
{
    private static InMemoryProvider P(Dictionary<string, string>? m = null) =>
        new(m ?? new Dictionary<string, string>(StringComparer.Ordinal));

    private static string Render(string format, object? payload, IProvider provider,
        string? template = null, string? @ref = null, int? maxChars = null) =>
        Renderer.Render(new RenderRequest
        {
            Template = template,
            Ref = @ref,
            Payload = payload,
            Provider = provider,
            Format = format,
            MaxChars = maxChars,
        });

    private static Dictionary<string, object> Obj(params (string k, object? v)[] kv)
    {
        var d = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var (k, v) in kv) d[k] = v!;
        return d;
    }

    [Fact]
    public void Renders_a_variable_text_raw() =>
        Assert.Equal("Hi Ada.", Render("text", Obj(("name", "Ada")), P(), template: "Hi {{name}}."));

    [Fact]
    public void Resolves_a_template_by_2layer_ref() =>
        Assert.Equal("Hi Ada.", Render("text", Obj(("name", "Ada")),
            P(new() { ["g/main"] = "Hi {{name}}." }), @ref: "g/main"));

    [Fact]
    public void Iterates_arrays_in_order() =>
        Assert.Equal("a,b,c,", Render("text", Obj(("xs", new List<object> { "a", "b", "c" })), P(),
            template: "{{#xs}}{{.}},{{/xs}}"));

    [Fact]
    public void Inverted_section_when_empty() =>
        Assert.Equal("none", Render("text", Obj(("xs", new List<object>())), P(),
            template: "{{^xs}}none{{/xs}}"));

    [Fact]
    public void Resolves_partials_through_the_provider() =>
        Assert.Equal("A [z] B", Render("text", Obj(("x", "z")),
            P(new() { ["g/main"] = "A {{> g/frag }} B", ["g/frag"] = "[{{x}}]" }), @ref: "g/main"));

    [Fact]
    public void Renders_a_partial_once_per_loop_iteration_in_item_context() =>
        Assert.Equal("<1><2>", Render("text",
            Obj(("items", new List<object> { Obj(("n", 1L)), Obj(("n", 2L)) })),
            P(new() { ["g/main"] = "{{#items}}{{> g/row }}{{/items}}", ["g/row"] = "<{{n}}>" }),
            @ref: "g/main"));

    [Fact]
    public void Detects_partial_cycles()
    {
        var ex = Assert.Throws<RenderException>(() =>
            Render("text", Obj(), P(new() { ["g/a"] = "{{> g/b }}", ["g/b"] = "{{> g/a }}" }), @ref: "g/a"));
        Assert.Contains("cycle", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Html_format_escapes_markup() =>
        Assert.Equal("&lt;b&gt;&amp;", Render("html", Obj(("x", "<b>&")), P(), template: "{{x}}"));

    [Fact]
    public void Text_format_does_not_escape() =>
        Assert.Equal("<b>&", Render("text", Obj(("x", "<b>&")), P(), template: "{{x}}"));

    [Fact]
    public void Triple_mustache_bypasses_escaping() =>
        Assert.Equal("<b>", Render("html", Obj(("x", "<b>")), P(), template: "{{{x}}}"));

    [Fact]
    public void Csv_format_neutralizes_formula_injection() =>
        Assert.Equal("'=cmd()", Render("csv", Obj(("x", "=cmd()")), P(), template: "{{x}}"));

    [Fact]
    public void Csv_format_quotes_values_with_commas() =>
        Assert.Equal("\"a,b\"", Render("csv", Obj(("x", "a,b")), P(), template: "{{x}}"));

    [Fact]
    public void Spreadsheet_format_xml_escapes_and_guards_injection() =>
        Assert.Equal("'=1&lt;2", Render("spreadsheet", Obj(("x", "=1<2")), P(), template: "{{x}}"));

    [Fact]
    public void Throws_on_unresolved_ref()
    {
        var ex = Assert.Throws<RenderException>(() => Render("text", Obj(), P(), @ref: "g/missing"));
        Assert.Contains("unresolved", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MaxChars_within_budget_returns_normally() =>
        // "Hi Ada." is 7 chars; a budget of 7 is exactly within budget.
        Assert.Equal("Hi Ada.", Render("text", Obj(("name", "Ada")), P(),
            template: "Hi {{name}}.", maxChars: 7));

    [Fact]
    public void MaxChars_over_budget_throws()
    {
        // "Hi Ada." is 7 chars; a budget of 6 is over budget → throw (TS parity).
        var ex = Assert.Throws<RenderException>(() =>
            Render("text", Obj(("name", "Ada")), P(), template: "Hi {{name}}.", maxChars: 6));
        Assert.Contains("maxChars", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("7 > 6", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void MaxChars_null_no_guard() =>
        // No budget set → long output renders without throwing.
        Assert.Equal("Hi Ada.", Render("text", Obj(("name", "Ada")), P(),
            template: "Hi {{name}}.", maxChars: null));

    [Fact]
    public void Deterministic_same_inputs_identical_output()
    {
        var payload = Obj(("xs", new List<object> { 1L, 2L, 3L }));
        var a = Render("text", payload, P(), template: "{{#xs}}{{.}}|{{/xs}}");
        var b = Render("text", payload, P(), template: "{{#xs}}{{.}}|{{/xs}}");
        Assert.Equal(a, b);
        Assert.Equal("1|2|3|", a);
    }
}
