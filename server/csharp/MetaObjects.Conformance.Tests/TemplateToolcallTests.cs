// template.toolcall — ADR-0011 cross-port parity (0.7.0-rc.7).
//
// The TS port shipped template.toolcall as a core subtype in 0.7.0-rc.5; this
// suite is C#'s parity coverage. Toolcall is a sibling of template.prompt and
// template.output but does NOT inherit the generic @payloadRef / @textRef /
// @format attrs — it declares its own minimal set (@toolName required +
// @payloadRef required + governance @owner / @since). No @textRef requirement
// because a tool-call has no renderable text body — the body IS the structured
// output schema resolved via @payloadRef.

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class TemplateToolcallTests
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

    // ------------------------------------------------------------------------
    // Registry — toolcall is a core subtype, shipped by CoreTypesProvider.
    // ------------------------------------------------------------------------

    [Fact]
    public void Core_provider_registers_template_toolcall_subtype()
    {
        var registry = FullCoreRegistry.Compose();
        Assert.True(registry.Has(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_TOOLCALL));
    }

    [Fact]
    public void Template_subtypes_array_lists_toolcall()
    {
        Assert.Equal("toolcall", TEMPLATE_SUBTYPE_TOOLCALL);
        Assert.Contains(TEMPLATE_SUBTYPE_TOOLCALL, TEMPLATE_SUBTYPES);
    }

    [Fact]
    public void Template_toolcall_attr_schema_does_not_inherit_generic_attrs()
    {
        // Per ADR-0011 the toolcall subtype does NOT inherit the prompt/output
        // generic attrs. It declares its own minimal set: toolName + payloadRef
        // + owner + since. @textRef and @format are intentionally absent.
        var registry = FullCoreRegistry.Compose();
        var def = registry.Find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_TOOLCALL);
        Assert.NotNull(def);

        var attrNames = def!.Attributes.Select(a => a.Name).ToHashSet();
        Assert.Equal(
            new HashSet<string>
            {
                TEMPLATE_ATTR_TOOL_NAME,
                TEMPLATE_ATTR_PAYLOAD_REF,
                TEMPLATE_ATTR_OWNER,
                TEMPLATE_ATTR_SINCE,
                TEMPLATE_ATTR_MAX_TOKENS, // #237 — vendor-agnostic per-call token budget
            },
            attrNames);

        Assert.DoesNotContain(TEMPLATE_ATTR_TEXT_REF, attrNames);
        Assert.DoesNotContain(TEMPLATE_ATTR_FORMAT, attrNames);

        // Required-ness mirrors the TS schema.
        var byName = def.Attributes.ToDictionary(a => a.Name);
        Assert.True(byName[TEMPLATE_ATTR_TOOL_NAME].Required);
        Assert.True(byName[TEMPLATE_ATTR_PAYLOAD_REF].Required);
        Assert.False(byName[TEMPLATE_ATTR_OWNER].Required);
        Assert.False(byName[TEMPLATE_ATTR_SINCE].Required);
    }

    // ------------------------------------------------------------------------
    // Loader — a valid template.toolcall declaration loads + validates clean.
    // ------------------------------------------------------------------------

    [Fact]
    public void Template_toolcall_loads_with_required_attrs()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::tools",
            "children": [
              { "object.value": {
                  "name": "WeatherToolOutput",
                  "children": [
                    { "field.string": { "name": "summary" } },
                    { "field.int":    { "name": "tempCelsius" } }
                  ]
              } },
              { "template.toolcall": {
                  "name": "lookupWeather",
                  "@toolName": "lookup_weather",
                  "@payloadRef": "WeatherToolOutput",
                  "@owner": "tools-team",
                  "@since": "0.7.0"
              } }
            ]
          } }
        """;

        var res = LoadJson(json, "meta.tools.json");

        Assert.Empty(res.Errors);

        var toolcall = res.Root.Children()
            .Single(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_TOOLCALL);
        Assert.Equal("lookupWeather", toolcall.Name);
        Assert.Equal("lookup_weather", toolcall.OwnAttr(TEMPLATE_ATTR_TOOL_NAME));
        Assert.Equal("WeatherToolOutput", toolcall.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF));
    }

    [Fact]
    public void Template_toolcall_missing_tool_name_emits_err_missing_required_attr()
    {
        // Required-attr check fires via the generic schema-driven required pass —
        // @toolName is declared required on the toolcall subtype's schema.
        const string json = """
        { "metadata.root": {
            "package": "acme::tools",
            "children": [
              { "object.value": {
                  "name": "Out",
                  "children": [
                    { "field.string": { "name": "x" } }
                  ]
              } },
              { "template.toolcall": {
                  "name": "missingToolName",
                  "@payloadRef": "Out"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.tools.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR && e.Message.Contains("@toolName"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Template_toolcall_bad_payload_ref_emits_err_invalid_template()
    {
        // The shared @payloadRef must-resolve-to-root-level-object.value rule
        // applies to toolcall the same as prompt + output (ValidationPasses
        // Pass 9 iterates ALL template.* subtypes).
        const string json = """
        { "metadata.root": {
            "package": "acme::tools",
            "children": [
              { "template.toolcall": {
                  "name": "danglingPayload",
                  "@toolName": "do_thing",
                  "@payloadRef": "DoesNotExist"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.tools.json");

        var err = res.Errors.FirstOrDefault(e => e.Code == ErrorCode.ERR_INVALID_TEMPLATE);
        Assert.NotNull(err);
    }
}
