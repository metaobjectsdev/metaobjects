using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Template-side drift checks, mirroring typescript/packages/render/test/verify.test.ts,
/// plus the render verify-on-resolve guard cases from render.test.ts.
/// </summary>
public class VerifyTests
{
    // AuthorBrief field tree (mirrors the payload-codegen VO walk):
    //   displayName: string; postCount: number;
    //   posts: { title: string; tags: { name: string }[] }[]
    private static readonly IReadOnlyList<PayloadField> AuthorBrief =
    [
        new PayloadField("displayName"),
        new PayloadField("postCount"),
        new PayloadField("posts",
        [
            new PayloadField("title"),
            new PayloadField("tags", [new PayloadField("name")]),
        ]),
    ];

    private static List<string> Codes(string text, IReadOnlyList<PayloadField> fields, VerifyOptions? o = null) =>
        Verify.Check(text, fields, o).Select(e => e.Code).ToList();

    private static InMemoryProvider P(Dictionary<string, string>? m = null) =>
        new(m ?? new Dictionary<string, string>(StringComparer.Ordinal));

    // --- interpolations ---

    [Fact] public void Known_scalar_var_no_drift() =>
        Assert.Empty(Verify.Check("Hi {{displayName}}.", AuthorBrief));

    [Fact] public void Unknown_var_is_drift_with_path()
    {
        var errs = Verify.Check("Hi {{notARealField}}.", AuthorBrief);
        Assert.Equal(new VerifyError(Verify.ERR_VAR_NOT_ON_PAYLOAD, "notARealField"), Assert.Single(errs));
    }

    [Fact] public void Unescaped_and_triple_are_checked() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD, Verify.ERR_VAR_NOT_ON_PAYLOAD],
            Codes("{{&nope}} {{{alsoNope}}}", AuthorBrief));

    [Fact] public void Implicit_iterator_is_valid() =>
        Assert.Empty(Verify.Check("{{.}}", AuthorBrief));

    // --- sections push the contextual VO ---

    [Fact] public void Section_element_field_resolves() =>
        Assert.Empty(Verify.Check("{{#posts}}{{title}}{{/posts}}", AuthorBrief));

    [Fact] public void Section_non_field_of_element_is_scoped_drift() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD], Codes("{{#posts}}{{title}}{{nope}}{{/posts}}", AuthorBrief));

    [Fact] public void Nested_sections_push_deeper() =>
        Assert.Empty(Verify.Check("{{#posts}}{{#tags}}{{name}}{{/tags}}{{/posts}}", AuthorBrief));

    [Fact] public void Deeply_nested_non_field_is_drift() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD], Codes("{{#posts}}{{#tags}}{{bogus}}{{/tags}}{{/posts}}", AuthorBrief));

    [Fact] public void Parent_context_fields_resolve_inside_section() =>
        Assert.Empty(Verify.Check("{{#posts}}{{title}} by {{displayName}}{{/posts}}", AuthorBrief));

    [Fact] public void Section_over_non_field_is_drift() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD], Codes("{{#ghosts}}{{x}}{{/ghosts}}", AuthorBrief));

    [Fact] public void Section_over_scalar_is_conditional_keeps_context()
    {
        Assert.Empty(Verify.Check("{{#postCount}}{{displayName}}{{/postCount}}", AuthorBrief));
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD], Codes("{{#postCount}}{{nope}}{{/postCount}}", AuthorBrief));
    }

    // --- inverted sections ---

    [Fact] public void Inverted_over_known_field_body_in_parent_is_clean() =>
        Assert.Empty(Verify.Check("{{^posts}}{{displayName}} has none{{/posts}}", AuthorBrief));

    [Fact] public void Inverted_over_non_field_is_drift() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD], Codes("{{^ghosts}}none{{/ghosts}}", AuthorBrief));

    // --- dotted paths ---

    [Fact] public void Valid_dotted_path_resolves() =>
        Assert.Empty(Verify.Check("{{posts.title}}", AuthorBrief));

    [Fact] public void Dotted_tail_non_field_is_drift() =>
        Assert.Equal(new VerifyError(Verify.ERR_VAR_NOT_ON_PAYLOAD, "posts.nope"),
            Assert.Single(Verify.Check("{{posts.nope}}", AuthorBrief)));

    [Fact] public void Dotted_head_non_field_is_drift() =>
        Assert.Equal(new VerifyError(Verify.ERR_VAR_NOT_ON_PAYLOAD, "ghost.title"),
            Assert.Single(Verify.Check("{{ghost.title}}", AuthorBrief)));

    // --- partials via the provider ---

    [Fact] public void Unresolved_partial_is_drift() =>
        Assert.Equal(new VerifyError(Verify.ERR_PARTIAL_UNRESOLVED, "g/missing"),
            Assert.Single(Verify.Check("a {{> g/missing}} b", AuthorBrief, new VerifyOptions { Provider = P() })));

    [Fact] public void Resolved_partial_body_checked_in_current_context() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD],
            Codes("{{> g/frag}}", AuthorBrief, new VerifyOptions { Provider = P(new() { ["g/frag"] = "{{displayName}}{{nope}}" }) }));

    [Fact] public void Partial_inside_section_checked_in_pushed_context() =>
        Assert.Equal([Verify.ERR_VAR_NOT_ON_PAYLOAD],
            Codes("{{#posts}}{{> g/row}}{{/posts}}", AuthorBrief, new VerifyOptions { Provider = P(new() { ["g/row"] = "{{title}}{{nope}}" }) }));

    [Fact] public void No_provider_partials_not_checked() =>
        Assert.Empty(Verify.Check("a {{> g/whatever}} b", AuthorBrief));

    // --- required slots ---

    [Fact] public void Required_slot_referenced_no_warning() =>
        Assert.Empty(Verify.Check("{{displayName}}", AuthorBrief, new VerifyOptions { RequiredSlots = ["displayName"] }));

    [Fact] public void Required_slot_unreferenced_warns() =>
        Assert.Equal(new VerifyError(Verify.ERR_REQUIRED_SLOT_UNUSED, "postCount"),
            Assert.Single(Verify.Check("{{displayName}}", AuthorBrief, new VerifyOptions { RequiredSlots = ["postCount"] })));

    [Fact] public void Required_slot_via_section_counts_as_used() =>
        Assert.Empty(Verify.Check("{{#posts}}{{title}}{{/posts}}", AuthorBrief, new VerifyOptions { RequiredSlots = ["posts"] }));

    // --- render verify-on-resolve guard (render.test.ts) ---

    private static readonly IReadOnlyList<PayloadField> Author =
        [new PayloadField("displayName"), new PayloadField("postCount")];

    [Fact] public void Guard_clean_template_renders()
    {
        var s = Renderer.Render(new RenderRequest
        {
            Template = "Hi {{displayName}}.", Payload = new Dictionary<string, object> { ["displayName"] = "Ada" },
            Provider = P(), Verify = Author,
        });
        Assert.Equal("Hi Ada.", s);
    }

    [Fact] public void Guard_drifted_variable_throws()
    {
        var ex = Assert.Throws<RenderException>(() => Renderer.Render(new RenderRequest
        {
            Template = "Hi {{notARealField}}.", Payload = new Dictionary<string, object>(), Provider = P(), Verify = Author,
        }));
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, ex.Message, StringComparison.Ordinal);
    }

    [Fact] public void Guard_checks_provider_resolved_text()
    {
        var ex = Assert.Throws<RenderException>(() => Renderer.Render(new RenderRequest
        {
            Ref = "g/dynamic", Payload = new Dictionary<string, object>(),
            Provider = P(new() { ["g/dynamic"] = "{{ghostField}}" }), Verify = Author,
        }));
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, ex.Message, StringComparison.Ordinal);
    }
}
