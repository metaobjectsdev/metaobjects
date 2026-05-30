// FR-010 metamodel attrs — cross-port parity.
//
// Registers the FR-010 field-teaching + prompt-presentation vocabulary in the C#
// loader, matching the Java pilot:
//   - @promptStyle  : closed enum (guide|inline|exampleOnly) on template.output ONLY,
//                     enforced via AllowedValues like @format. Default "guide".
//   - @example      : free-text string on any field (CommonFieldAttrs).
//   - @instruction  : free-text string on any field (CommonFieldAttrs).
//   - @enumAlias    : properties (map) on field.enum — off-vocab → canonical member.
//   - @enumDoc      : properties (map) on field.enum — member → human doc.

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr010LoaderAttrsTests
{
    private static LoadResult LoadJson(string json, string id)
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: id),
        });
    }

    private static TypeRegistry Registry() =>
        Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    // ------------------------------------------------------------------------
    // @promptStyle — registered on template.output, closed enum, default guide.
    // ------------------------------------------------------------------------

    [Fact]
    public void Template_output_registers_prompt_style_closed_enum()
    {
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_PROMPT_STYLE));
        var ps = byName[TEMPLATE_ATTR_PROMPT_STYLE];
        Assert.False(ps.Required);
        Assert.Equal(PROMPT_STYLE_DEFAULT, ps.Default);
        Assert.NotNull(ps.AllowedValues);
        Assert.Equal(
            new HashSet<string> { PROMPT_STYLE_GUIDE, PROMPT_STYLE_INLINE, PROMPT_STYLE_EXAMPLE_ONLY },
            ps.AllowedValues!.Select(v => v?.ToString()).ToHashSet());
    }

    [Fact]
    public void Prompt_subtype_does_not_carry_prompt_style()
    {
        // @promptStyle is output-only — the prompt fragment is an output concern.
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
        Assert.NotNull(def);
        Assert.DoesNotContain(TEMPLATE_ATTR_PROMPT_STYLE, def!.Attributes.Select(a => a.Name));
    }

    [Fact]
    public void Template_output_loads_with_valid_prompt_style()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "AnswerPayload",
                  "children": [ { "field.string": { "name": "text" } } ]
              } },
              { "template.output": {
                  "name": "answer",
                  "@payloadRef": "AnswerPayload",
                  "@textRef": "ai/answer",
                  "@format": "json",
                  "@promptStyle": "inline"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.Empty(res.Errors);
        var tmpl = res.Root.Children()
            .Single(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_OUTPUT);
        Assert.Equal(PROMPT_STYLE_INLINE, tmpl.OwnAttr(TEMPLATE_ATTR_PROMPT_STYLE));
    }

    [Fact]
    public void Template_output_bad_prompt_style_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "AnswerPayload",
                  "children": [ { "field.string": { "name": "text" } } ]
              } },
              { "template.output": {
                  "name": "answer",
                  "@payloadRef": "AnswerPayload",
                  "@textRef": "ai/answer",
                  "@format": "json",
                  "@promptStyle": "bogus"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("promptStyle"));
        Assert.NotNull(err);
    }

    // ------------------------------------------------------------------------
    // @enumAlias / @enumDoc — properties maps on field.enum.
    // @example / @instruction — strings on any field.
    // ------------------------------------------------------------------------

    [Fact]
    public void Field_enum_registers_alias_doc_example_instruction()
    {
        var def = Registry().Find(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.Equal(ATTR_SUBTYPE_PROPERTIES, byName[FIELD_ATTR_ENUM_ALIAS].ValueType);
        Assert.Equal(ATTR_SUBTYPE_PROPERTIES, byName[FIELD_ATTR_ENUM_DOC].ValueType);
        Assert.Equal(ATTR_SUBTYPE_STRING, byName[FIELD_ATTR_EXAMPLE].ValueType);
        Assert.Equal(ATTR_SUBTYPE_STRING, byName[FIELD_ATTR_INSTRUCTION].ValueType);
    }

    [Fact]
    public void Example_and_instruction_are_registered_on_a_plain_string_field()
    {
        // They live on CommonFieldAttrs, so every field subtype carries them.
        var def = Registry().Find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
        Assert.NotNull(def);
        var names = def!.Attributes.Select(a => a.Name).ToHashSet();
        Assert.Contains(FIELD_ATTR_EXAMPLE, names);
        Assert.Contains(FIELD_ATTR_INSTRUCTION, names);
    }

    [Fact]
    public void Field_enum_loads_with_alias_doc_example_instruction()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "AnswerPayload",
                  "children": [
                    { "field.enum": {
                        "name": "confidence",
                        "@values": ["HIGH", "LOW"],
                        "@enumAlias": { "hi": "HIGH", "lo": "LOW" },
                        "@enumDoc":   { "HIGH": "Directly supported.", "LOW": "A guess." },
                        "@example": "HIGH",
                        "@instruction": "Pick one."
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.Empty(res.Errors);
        var field = res.Root.Children()
            .Single(c => c.Type == TYPE_OBJECT)
            .Children().Single(c => c.Type == TYPE_FIELD && c.SubType == FIELD_SUBTYPE_ENUM);

        var alias = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(
            field.OwnAttr(FIELD_ATTR_ENUM_ALIAS));
        Assert.Equal("HIGH", alias["hi"]);
        Assert.Equal("LOW", alias["lo"]);

        var doc = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(
            field.OwnAttr(FIELD_ATTR_ENUM_DOC));
        Assert.Equal("Directly supported.", doc["HIGH"]);

        Assert.Equal("HIGH", field.OwnAttr(FIELD_ATTR_EXAMPLE));
        Assert.Equal("Pick one.", field.OwnAttr(FIELD_ATTR_INSTRUCTION));
    }

    [Fact]
    public void Field_enum_alias_must_be_a_map_not_a_string()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "AnswerPayload",
                  "children": [
                    { "field.enum": {
                        "name": "confidence",
                        "@values": ["HIGH", "LOW"],
                        "@enumAlias": "not-a-map"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("enumAlias"));
        Assert.NotNull(err);
    }
}
