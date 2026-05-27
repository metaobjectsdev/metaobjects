// FR5d — reference-resolution errors emit format=resolved with referrer + target.
//
// Covers the five reference sites listed in
//   docs/superpowers/specs/2026-05-25-fr5d-reference-resolution-errors.md:
//   1. extends:                  ERR_UNRESOLVED_SUPER
//   2. @payloadRef on template.* ERR_INVALID_TEMPLATE
//   3. @requiredSlots field-on-payload ref  (template.*)
//   4. @via path on origin       ERR_INVALID_ORIGIN
//   5. @of / @from path on origin ERR_INVALID_ORIGIN
//
// Per the FR5d cross-port-safety stance, C# emits the new format=resolved
// envelope but the cross-port fixtures stay on the FR5a format=json envelope
// until all four ports ship FR5d (ledgered as known-gap in
// conformance-expected-failures.json). These unit tests assert the in-process
// C# shape directly. Mirrors the TS reference test pattern in
// server/typescript/packages/metadata/test/fr5d-reference-resolution-errors.test.ts.

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr5dReferenceResolutionTests
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static LoadResult LoadJson(string json, string id)
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: id),
        });
    }

    private static void AssertResolved(
        MetaError err,
        ErrorCode code,
        string referrer,
        string target,
        IReadOnlyList<string>? files = null)
    {
        Assert.Equal(code, err.Code);
        Assert.NotNull(err.Envelope);
        Assert.Equal("resolved", err.Envelope!.Format);
        var rs = Assert.IsType<ResolvedSource>(err.Envelope);
        Assert.Equal(referrer, rs.Referrer);
        Assert.Equal(target, rs.Target);
        if (files is not null)
        {
            Assert.Equal(files, rs.Files);
        }
        else
        {
            // files[] always present on a resolved envelope; the referrer's
            // parse-time source supplies it.
            Assert.NotNull(rs.Files);
        }
    }

    // -------------------------------------------------------------------------
    // extends: emits format=resolved
    // -------------------------------------------------------------------------

    [Fact]
    public void Extends_unresolved_emits_resolved_envelope_with_entity_fqn_and_target()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Premium",
                  "extends": "DoesNotExist",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.bad.json");
        var err = Assert.Single(res.Errors);
        // C# today: objects at the root do not inherit the root's package, so
        // obj.Fqn() returns the bare name. Cross-port note: matches TS exactly
        // (TS also emits "Premium" — see TS test parity comment).
        AssertResolved(err,
            ErrorCode.ERR_UNRESOLVED_SUPER,
            referrer: "Premium",
            target: "DoesNotExist",
            files: new[] { "meta.bad.json" });
    }

    // -------------------------------------------------------------------------
    // @payloadRef emits format=resolved
    // -------------------------------------------------------------------------

    [Fact]
    public void Template_payloadRef_unresolved_emits_resolved_envelope()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.entity": {
                  "name": "Npc",
                  "children": [
                    { "field.string": { "name": "name" } },
                    { "identity.primary": { "@fields": "name" } }
                  ]
              } },
              { "template.prompt": {
                  "name": "npcTurn",
                  "@payloadRef": "NpcPromptPayload",
                  "@textRef": "npc/turn",
                  "@format": "xml"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");
        var err = res.Errors.FirstOrDefault(e => e.Code == ErrorCode.ERR_INVALID_TEMPLATE);
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_TEMPLATE,
            referrer: "npcTurn",
            target: "NpcPromptPayload",
            files: new[] { "meta.ai.json" });
    }

    [Fact]
    public void Template_requiredSlots_missing_field_emits_resolved_with_dotted_target()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "PromptPayload",
                  "children": [ { "field.string": { "name": "name" } } ]
              } },
              { "template.prompt": {
                  "name": "tmpl",
                  "@payloadRef": "PromptPayload",
                  "@textRef": "tmpl/x",
                  "@format": "xml",
                  "@requiredSlots": ["name", "doesNotExist"]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_TEMPLATE &&
            e.Message.Contains("doesNotExist"));
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_TEMPLATE,
            referrer: "tmpl",
            target: "PromptPayload.doesNotExist",
            files: new[] { "meta.ai.json" });
    }

    // -------------------------------------------------------------------------
    // @via emits format=resolved (+ deepest-valid-prefix in message)
    // -------------------------------------------------------------------------

    [Fact]
    public void Via_to_nonexistent_relationship_emits_resolved_with_deepest_valid_prefix()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::commerce",
            "children": [
              { "object.entity": {
                  "name": "Program",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "field.string": { "name": "title" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "ProgramSummary",
                  "extends": "Program",
                  "children": [
                    { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
                    { "field.int": {
                        "name": "weekCount",
                        "children": [
                          { "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Program.id",
                              "@via": "Program.notARealRelationship"
                          } }
                        ]
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.commerce.json");
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_ORIGIN &&
            e.Message.Contains("notARealRelationship"));
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_ORIGIN,
            referrer: "ProgramSummary::weekCount",
            target: "Program.notARealRelationship",
            files: new[] { "meta.commerce.json" });
        // Deepest-valid-prefix is "Program" (the entity resolved before the
        // relationship hop failed).
        Assert.Contains("Deepest valid prefix was \"Program\"", err!.Message);
    }

    [Fact]
    public void Multi_hop_via_deepest_valid_prefix_names_the_hop_that_did_resolve()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::commerce",
            "children": [
              { "object.entity": {
                  "name": "Week",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "Program",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.association": {
                        "name": "weeks",
                        "@objectRef": "Week"
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "ProgramSummary",
                  "extends": "Program",
                  "children": [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    { "field.int": {
                        "name": "deepCount",
                        "children": [
                          { "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Week.id",
                              "@via": "Program.weeks.notReal"
                          } }
                        ]
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.json");
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_ORIGIN &&
            e.Message.Contains("notReal"));
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_ORIGIN,
            referrer: "ProgramSummary::deepCount",
            target: "Program.weeks.notReal");
        // The walk got past Program.weeks (resolved to Week) and failed on `.notReal`.
        Assert.Contains("Deepest valid prefix was \"Program.weeks\"", err!.Message);
    }

    // -------------------------------------------------------------------------
    // @of / @from emits format=resolved
    // -------------------------------------------------------------------------

    [Fact]
    public void Aggregate_of_to_nonexistent_entity_emits_resolved()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::commerce",
            "children": [
              { "object.entity": {
                  "name": "Program",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.association": {
                        "name": "weeks",
                        "@objectRef": "Week"
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "Week",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "ProgramSummary",
                  "extends": "Program",
                  "children": [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    { "field.int": {
                        "name": "weekCount",
                        "children": [
                          { "origin.aggregate": {
                              "@agg": "count",
                              "@of": "GhostEntity.id",
                              "@via": "Program.weeks"
                          } }
                        ]
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.json");
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_ORIGIN &&
            e.Message.Contains("GhostEntity"));
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_ORIGIN,
            referrer: "ProgramSummary::weekCount",
            target: "GhostEntity.id");
    }

    [Fact]
    public void Aggregate_of_existing_entity_missing_field_emits_resolved()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::commerce",
            "children": [
              { "object.entity": {
                  "name": "Program",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "relationship.association": {
                        "name": "weeks",
                        "@objectRef": "Week"
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "Week",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } },
              { "object.entity": {
                  "name": "ProgramSummary",
                  "extends": "Program",
                  "children": [
                    { "source.rdb": { "@kind": "view", "@table": "v" } },
                    { "field.int": {
                        "name": "weekCount",
                        "children": [
                          { "origin.aggregate": {
                              "@agg": "count",
                              "@of": "Week.ghostField",
                              "@via": "Program.weeks"
                          } }
                        ]
                    } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.json");
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_INVALID_ORIGIN &&
            e.Message.Contains("ghostField"));
        Assert.NotNull(err);
        AssertResolved(err!,
            ErrorCode.ERR_INVALID_ORIGIN,
            referrer: "ProgramSummary::weekCount",
            target: "Week.ghostField");
    }

    // -------------------------------------------------------------------------
    // resolved-envelope shape contracts
    // -------------------------------------------------------------------------

    [Fact]
    public void Resolved_source_carries_referrers_files_and_jsonPath()
    {
        const string json = """
        { "metadata.root": {
            "package": "p",
            "children": [
              { "object.entity": {
                  "name": "A",
                  "extends": "Ghost",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": "id" } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "input/A.json");
        var err = Assert.Single(res.Errors);
        var rs = Assert.IsType<ResolvedSource>(err.Envelope);
        Assert.Equal("resolved", rs.Format);
        Assert.Equal(new[] { "input/A.json" }, rs.Files);
        // jsonPath is populated by the parser so the IDE/editor can pinpoint
        // the `extends:` declaration on disk.
        Assert.NotNull(rs.JsonPath);
        Assert.Contains("$", rs.JsonPath!);
    }
}
