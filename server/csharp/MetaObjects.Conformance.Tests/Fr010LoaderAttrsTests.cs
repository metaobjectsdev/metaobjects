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
        var registry = FullCoreRegistry.Compose();
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: id),
        });
    }

    private static TypeRegistry Registry() =>
        FullCoreRegistry.Compose();

    // ------------------------------------------------------------------------
    // @promptStyle — registered on template.PROMPT (ADR-0052), closed enum, default
    // guide. It governs a fragment that instructs an LLM how to format its reply, so
    // hosting it on the subtype defined as "every rendered artifact other than an LLM
    // prompt" was a contradiction visible in the attribute's own description.
    //
    // @responseFormat — ADR-0053, beside it: the syntax of the REPLY, distinct from
    // @format, which is the syntax of the rendered prompt BODY.
    // ------------------------------------------------------------------------

    /// <summary>
    /// A prompt carrying the full inbound half. Note @format text alongside
    /// @responseFormat xml — the prompt body and the reply are independently typed,
    /// which is the shape a single @format could not express.
    /// </summary>
    private static string InboundPrompt(string responseFormat, string promptStyle) => $$"""
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "AskPayload",
                  "children": [ { "field.string": { "name": "question" } } ]
              } },
              { "object.value": {
                  "name": "AnswerPayload",
                  "children": [ { "field.string": { "name": "text" } } ]
              } },
              { "template.prompt": {
                  "name": "ask",
                  "@payloadRef": "AskPayload",
                  "@responseRef": "AnswerPayload",
                  "@textRef": "ai/ask",
                  "@format": "text",
                  "@responseFormat": "{{responseFormat}}",
                  "@promptStyle": "{{promptStyle}}"
              } }
            ]
          } }
        """;

    [Fact]
    public void Template_prompt_registers_prompt_style_closed_enum()
    {
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
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
    public void Template_prompt_registers_response_format_closed_enum()
    {
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_RESPONSE_FORMAT));
        var rf = byName[TEMPLATE_ATTR_RESPONSE_FORMAT];
        Assert.False(rf.Required);
        Assert.Equal(RESPONSE_FORMAT_DEFAULT, rf.Default);
        Assert.NotNull(rf.AllowedValues);
        // TWO members, not TEMPLATE_FORMATS' seven — the rest are
        // reserved-not-registered until a shipping consumer dispatches on them.
        Assert.Equal(
            new HashSet<string> { RESPONSE_FORMAT_JSON, RESPONSE_FORMAT_XML },
            rf.AllowedValues!.Select(v => v?.ToString()).ToHashSet());
    }

    [Fact]
    public void Output_subtype_does_not_carry_the_inbound_attrs()
    {
        // ADR-0052/0053: template.output is outbound only — it parses nothing, so it
        // has neither a fragment presentation nor a reply syntax.
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT);
        Assert.NotNull(def);
        var names = def!.Attributes.Select(a => a.Name).ToList();
        Assert.DoesNotContain(TEMPLATE_ATTR_PROMPT_STYLE, names);
        Assert.DoesNotContain(TEMPLATE_ATTR_RESPONSE_FORMAT, names);
    }

    [Fact]
    public void Template_prompt_loads_with_valid_inbound_attrs()
    {
        var res = LoadJson(InboundPrompt("xml", "inline"), "meta.ai.json");

        Assert.Empty(res.Errors);
        var tmpl = res.Root.Children()
            .Single(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_PROMPT);
        Assert.Equal(PROMPT_STYLE_INLINE, tmpl.OwnAttr(TEMPLATE_ATTR_PROMPT_STYLE));
        Assert.Equal(TEMPLATE_FORMAT_DEFAULT, tmpl.OwnAttr(TEMPLATE_ATTR_FORMAT));
        Assert.Equal(RESPONSE_FORMAT_XML, tmpl.OwnAttr(TEMPLATE_ATTR_RESPONSE_FORMAT));
    }

    [Fact]
    public void Template_prompt_bad_prompt_style_emits_err_bad_attr_value()
    {
        var res = LoadJson(InboundPrompt("json", "bogus"), "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("promptStyle"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Template_prompt_bad_response_format_emits_err_bad_attr_value()
    {
        // "markdown" is a legal @format but NOT a legal @responseFormat — nothing
        // dispatches on it inbound (ADR-0053).
        var res = LoadJson(InboundPrompt("markdown", "guide"), "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("responseFormat"));
        Assert.NotNull(err);
    }

    // ------------------------------------------------------------------------
    // @kind + email part-refs (template.output only) — closed enum (document|email),
    // conditional ref requirements (email→subjectRef+htmlBodyRef; document/absent→textRef).
    // ------------------------------------------------------------------------

    [Fact]
    public void Template_output_registers_kind_closed_enum_and_email_refs()
    {
        var def = Registry().Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_KIND));
        var kind = byName[TEMPLATE_ATTR_KIND];
        Assert.False(kind.Required);
        Assert.Equal(TEMPLATE_KIND_DEFAULT, kind.Default);
        Assert.NotNull(kind.AllowedValues);
        Assert.Equal(
            new HashSet<string> { TEMPLATE_KIND_DOCUMENT, TEMPLATE_KIND_EMAIL },
            kind.AllowedValues!.Select(v => v?.ToString()).ToHashSet());

        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_SUBJECT_REF));
        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_HTML_BODY_REF));
        Assert.True(byName.ContainsKey(TEMPLATE_ATTR_TEXT_BODY_REF));
        Assert.False(byName[TEMPLATE_ATTR_SUBJECT_REF].Required);
        Assert.False(byName[TEMPLATE_ATTR_HTML_BODY_REF].Required);
        Assert.False(byName[TEMPLATE_ATTR_TEXT_BODY_REF].Required);
        // @textRef is relaxed to non-required (conditionally enforced in validation).
        Assert.False(byName[TEMPLATE_ATTR_TEXT_REF].Required);
    }

    [Fact]
    public void Template_output_email_with_subject_and_html_loads_ok()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "MailPayload",
                  "children": [ { "field.string": { "name": "name" } } ]
              } },
              { "template.output": {
                  "name": "welcome",
                  "@payloadRef": "MailPayload",
                  "@kind": "email",
                  "@subjectRef": "mail/welcome.subject",
                  "@htmlBodyRef": "mail/welcome.html"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.mail.json");

        Assert.Empty(res.Errors);
        var tmpl = res.Root.Children()
            .Single(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_OUTPUT);
        Assert.Equal(TEMPLATE_KIND_EMAIL, tmpl.OwnAttr(TEMPLATE_ATTR_KIND));
    }

    [Fact]
    public void Template_output_email_missing_subject_emits_err_invalid_template()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "MailPayload",
                  "children": [ { "field.string": { "name": "name" } } ]
              } },
              { "template.output": {
                  "name": "welcome",
                  "@payloadRef": "MailPayload",
                  "@kind": "email",
                  "@htmlBodyRef": "mail/welcome.html"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.mail.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_TEMPLATE && e.Message.Contains("subjectRef"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Template_output_document_missing_text_ref_emits_err_invalid_template()
    {
        // @kind absent → defaults to document → @textRef required.
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "DocPayload",
                  "children": [ { "field.string": { "name": "body" } } ]
              } },
              { "template.output": {
                  "name": "report",
                  "@payloadRef": "DocPayload",
                  "@format": "markdown"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.doc.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_TEMPLATE && e.Message.Contains("textRef"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Template_output_bad_kind_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "DocPayload",
                  "children": [ { "field.string": { "name": "body" } } ]
              } },
              { "template.output": {
                  "name": "report",
                  "@payloadRef": "DocPayload",
                  "@textRef": "ai/report",
                  "@kind": "bogus"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.doc.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("kind"));
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
