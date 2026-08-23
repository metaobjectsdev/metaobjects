// #294 — the C# EF Core target emits explicit 1:N relationship configuration carrying
// the ADR-0047 referential action.
//
// Before this, DbContextGenerator emitted NO relationship configuration for a plain
// foreign key at all: the generated entity carries a bare scalar FK property and no
// navigation, so EF Core built no relationship, GetForeignKeys() was empty, and every
// DeleteBehavior fell back to EF's convention regardless of what the metadata — or the
// database — said. @onDelete was inert on this port.
//
// These tests pin the RESOLUTION (the ADR-0047 precedence, ported from the migrate-ts
// SSOT) and the EMISSION SHAPE. That the emitted model is durable through EF's own
// finalization — the TPH failure the issue reports — is pinned separately by
// Issue294EfModelDeleteBehaviorTests, which builds a real EF model and reads the
// behavior back.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Issue294ReferentialActionTests
{
    // Program (parent, declares the to-many composition) / Week (owns the FK).
    // The reference carries whatever @onDelete the test injects; the parent-side
    // relationship is the documented authoring shape and drives tier-3 correlation.
    // Tokens are substituted before parsing, so they never reach the JSON reader.
    // (String tokens rather than interpolation: the model is dense in `}}`, which an
    // interpolated raw string would read as an interpolation hole.)
    private const string TwoEntityTemplate = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Program", "children": [
        { "source.rdb": { "@table": "programs" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } },
        { "relationship.composition": { "name": "weeks", "@cardinality": "many", "@objectRef": "Week" } }
      ]}},
      { "object.entity": { "name": "Week", "children": [
        { "source.rdb": { "@table": "weeks" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId"/*FK_ATTRS*/ } },
        { "identity.primary": { "@fields": "id" } }/*WEEK_REL*/,
        { "identity.reference": { "name": "refProgram", "@fields": "programId",
          "@references": "Program"/*REF_ATTRS*/ } }
      ]}}
    ]}}
    """;

    private static string TwoEntityModel(
        string referenceAttrs = "", string weekRelationship = "", string programIdAttrs = "") =>
        TwoEntityTemplate
            .Replace("/*REF_ATTRS*/", referenceAttrs)
            .Replace("/*WEEK_REL*/", weekRelationship)
            .Replace("/*FK_ATTRS*/", programIdAttrs);

    private static (string Source, List<string> Warnings) Generate(string model)
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "issue-294.json")]);
        Assert.Empty(result.Errors);

        var warnings = new List<string>();
        var ctx = new GenContext
        {
            Entities = result.Root.Objects(),
            Root = result.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Generated" },
            Warn = warnings.Add,
        };
        var file = Assert.Single(new DbContextGenerator().Generate(ctx));
        return (file.Content, warnings);
    }

    private static string WeekFkLine(string source) =>
        Assert.Single(source.Split('\n'), l => l.Contains("HasOne<Program>()")).Trim();

    [Fact]
    public void A_plain_reference_now_configures_a_real_foreign_key()
    {
        var (source, _) = Generate(TwoEntityModel());
        // The FK must be established by the config call itself — never a later
        // GetForeignKeys() mutation, which TPH finalization can silently discard (#294).
        Assert.Equal(
            "modelBuilder.Entity<Week>().HasOne<Program>().WithMany()"
            + ".HasForeignKey(nameof(Week.ProgramId)).OnDelete(DeleteBehavior.Cascade);",
            WeekFkLine(source));
        Assert.DoesNotContain("GetForeignKeys", source);
    }

    [Fact]
    public void Tier1_an_action_on_the_reference_itself_wins()
    {
        var (source, _) = Generate(TwoEntityModel(referenceAttrs: """, "@onDelete": "restrict" """));
        Assert.Contains(".OnDelete(DeleteBehavior.Restrict)", WeekFkLine(source));
    }

    [Fact]
    public void Tier2_a_sibling_relationship_beats_the_parent_side_one()
    {
        // Week's own association (restrict) must win over Program's composition (cascade).
        var (source, _) = Generate(TwoEntityModel(weekRelationship: """
        ,{ "relationship.association": { "name": "program", "@cardinality": "one", "@objectRef": "Program" } }
        """));
        Assert.Contains(".OnDelete(DeleteBehavior.Restrict)", WeekFkLine(source));
    }

    [Fact]
    public void Tier3_the_parent_side_composition_supplies_its_subtype_default()
    {
        // No action anywhere: the only source is Program's to-many composition, whose
        // subtype default is cascade. This is the shape the authoring docs teach.
        var (source, _) = Generate(TwoEntityModel());
        Assert.Contains(".OnDelete(DeleteBehavior.Cascade)", WeekFkLine(source));
    }

    [Fact]
    public void No_action_is_stated_explicitly_rather_than_left_to_EF_s_convention()
    {
        // Tempting to emit nothing here — `no-action` IS the database default, and the
        // TS-owned DDL writes no ON DELETE clause for it. But EF does not treat an absent
        // OnDelete as "no action": it applies its own convention, which for a REQUIRED
        // foreign key is Cascade. Omitting the call would therefore make the generated
        // context delete rows the database would refuse to orphan.
        var (source, _) = Generate(TwoEntityModel(referenceAttrs: """, "@onDelete": "no-action" """));
        Assert.Contains(".OnDelete(DeleteBehavior.NoAction)", WeekFkLine(source));
    }

    [Fact]
    public void An_uncorrelated_reference_is_NoAction_too()
    {
        // No @onDelete, and no relationship on either side to correlate with: the resolved
        // action is "none", which must still be stated for the reason above.
        var (source, _) = Generate("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "source.rdb": { "@table": "programs" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Week", "children": [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.reference": { "name": "refProgram", "@fields": "programId",
              "@references": "Program" } }
          ]}}
        ]}}
        """);
        Assert.Contains(".OnDelete(DeleteBehavior.NoAction)", WeekFkLine(source));
    }

    [Fact]
    public void Set_null_over_a_required_fk_warns_instead_of_breaking_model_validation()
    {
        // EF fails MODEL VALIDATION for SetNull over a non-nullable FK, which would take
        // down the entire DbContext rather than one relationship. Warn and omit.
        var (source, warnings) = Generate(TwoEntityModel(
            referenceAttrs: """, "@onDelete": "set-null" """,
            programIdAttrs: ""","@required": true"""));

        // NoAction rather than nothing: an omitted call would leave EF's convention in
        // charge, and for this REQUIRED foreign key that convention is Cascade — turning
        // an unsatisfiable set-null into destructive cascade deletes.
        Assert.Contains(".OnDelete(DeleteBehavior.NoAction)", WeekFkLine(source));
        Assert.Contains(warnings, w => w.Contains("SET NULL") && w.Contains("programId"));
    }

    [Fact]
    public void A_logical_only_reference_configures_nothing()
    {
        // ADR-0046 — @enforce:false is a navigation-only reference with no FK at all.
        var (source, _) = Generate(TwoEntityModel(referenceAttrs: """, "@enforce": false """));
        Assert.DoesNotContain("HasOne<Program>()", source);
    }

    // A TPH base and one concrete subtype declaring the SAME foreign key — the exact
    // shape #294 reports. The physical column is one column on the shared table, so it
    // must be configured exactly ONCE; a duplicate configuration is what made the
    // adopter's post-hoc mutation unreliable.
    private const string TphDualDeclaration = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "User", "children": [
        { "source.rdb": { "@table": "users" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Item", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "kind", "@values": ["Alpha", "Beta"] } },
        { "field.long": { "name": "senderId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refSender", "@fields": "senderId",
          "@references": "User", "@onDelete": "cascade" } }
      ]}},
      { "object.entity": { "name": "AlphaItem", "extends": "Item", "@discriminatorValue": "Alpha",
        "children": [
        { "identity.reference": { "name": "refSenderAlpha", "@fields": "senderId",
          "@references": "User", "@onDelete": "cascade" } }
      ]}},
      { "object.entity": { "name": "BetaItem", "extends": "Item", "@discriminatorValue": "Beta",
        "children": [
        { "field.string": { "name": "note", "@maxLength": 40 } }
      ]}}
    ]}}
    """;

    [Fact]
    public void A_tph_base_and_subtype_declaring_the_same_fk_configure_it_once()
    {
        var (source, _) = Generate(TphDualDeclaration);
        var fkLines = source.Split('\n').Where(l => l.Contains("HasOne<User>()")).ToList();

        var line = Assert.Single(fkLines);
        // Configured on the BASE, which owns the shared table's column.
        Assert.Contains("modelBuilder.Entity<Item>()", line);
        Assert.Contains(".OnDelete(DeleteBehavior.Cascade)", line);
    }

    [Fact]
    public void A_model_with_no_enforced_reference_is_unchanged()
    {
        // Guards the byte-identical promise for models this feature does not touch.
        var (source, _) = Generate("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Solo", "children": [
            { "source.rdb": { "@table": "solos" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """);
        Assert.DoesNotContain("HasOne<", source);
        Assert.DoesNotContain("OnDelete(", source);
    }
}
