// "Those names classes should extend from the parent class, not just redo all the names."
//
// A TPH subtype's artifact restated its base's table name and every one of its columns; an
// entity extending an abstract base restated every inherited column. Each restatement is a
// second place one physical name is spelled — the exact defect <Entity>Names exists to
// remove, reintroduced one level up.
//
// Every assertion is stated in the NEGATIVE as well as the positive: an inherited physical
// name must be ABSENT from the child's class. A positive-only assertion would pass just as
// well for a generator emitting both the base reference AND the restated literal, which is
// the outcome this change exists to prevent.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class NamesExtendsChainTests
{
    // Physical names deliberately unrelated to their logical names: a restated literal
    // cannot be mistaken for a re-derivation.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
        { "field.long":      { "name": "id" } },
        { "field.timestamp": { "name": "createdAt", "@column": "zz_made_at" } }
      ]}},
      { "object.entity": { "name": "Author", "extends": "BaseEntity", "children": [
        { "source.rdb":   { "@table": "zz_authors" } },
        { "field.string": { "name": "email", "@column": "zz_email_addr", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "kind", "children": [
        { "source.rdb":   { "@table": "zz_auths" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "kind", "@values": ["Copay"] } },
        { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay",
        "children": [
        { "field.long": { "name": "copayAmount", "@column": "zz_copay_cents" } }
      ]}},
      { "object.value": { "name": "Money", "children": [
        { "field.long": { "name": "cents", "@column": "zz_cents" } }
      ]}}
    ]}}
    """;

    private static Dictionary<string, string> Generate()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "extends.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig
            {
                OutDir = "/unused", Namespace = "Acme.Generated",
                ColumnNamingStrategy = ColumnNamingStrategy.SnakeCase, IncludeNames = true,
            },
        };
        return new NamesGenerator().Generate(ctx).ToDictionary(f => f.Path, f => f.Content);
    }

    [Fact]
    public void The_abstract_base_gets_a_class_of_its_own_carrying_columns_and_no_physical_name()
    {
        var src = Generate()["BaseEntityNames.g.cs"];
        Assert.Contains("public abstract class BaseEntityNames", src);
        Assert.Contains("public const string CreatedAtColumn = \"zz_made_at\";", src);
        Assert.Contains("public const string IdColumn = \"id\";", src);
        // It declares no source, so it carries NO source member group. A physical name here
        // would be one invented for an object that declares none — the phantom-table failure
        // #248 exists to prevent.
        Assert.DoesNotContain("SourcePrimary", src);
        Assert.DoesNotContain("SourceReplica", src);
        Assert.DoesNotContain("ReadOnly", src);
        // A fragment still carries its OWN identity — type, subType and its object name —
        // because those are facts about the node, not about a source it does not have.
        Assert.Contains("public const string Type = \"object\";", src);
        Assert.Contains("public const string Name = \"BaseEntity\";", src);
    }

    [Fact]
    public void The_child_extends_the_base_and_declares_only_its_own_column()
    {
        var src = Generate()["AuthorNames.g.cs"];
        Assert.Contains("public abstract class AuthorNames : BaseEntityNames", src);
        Assert.Contains("public const string EmailColumn = \"zz_email_addr\";", src);
        // Its own source, so its own physical name — under the alias for its @kind.
        Assert.Contains("public const string SourcePrimaryTable = \"zz_authors\";", src);
        // Every artifact declares Type/SubType/Name of its own now, so a derived one HIDES
        // three of its base's members. Without `new` that is CS0108 on every generated file
        // with a base, and a generator that emits warnings trains a reader to ignore them.
        Assert.Contains("public new const string Name = \"Author\";", src);
        Assert.Contains("public new const string Type = \"object\";", src);
        // ...and NOT the inherited column, restated.
        Assert.DoesNotContain("zz_made_at", src);
    }

    [Fact]
    public void A_tph_subtype_inherits_the_shared_table_name_rather_than_restating_it()
    {
        var src = Generate()["CopayAuthNames.g.cs"];
        Assert.Contains("public abstract class CopayAuthNames : AuthNames", src);
        Assert.Contains("public const string CopayAmountColumn = \"zz_copay_cents\";", src);
        // The whole point: the subtype used to restate the base's table name and every one
        // of its columns.
        Assert.DoesNotContain("zz_auths", src);
        Assert.DoesNotContain("KindColumn =", src);
        Assert.DoesNotContain("IdColumn =", src);
    }

    // An intermediate abstract that declares NO field and NO source, only a key.
    //
    // `Audited` exists to carry one identity.secondary down a chain. The "has anything to
    // contribute" test used to ask about fields and sources alone, so this node answered
    // "no": the walk stepped over it, no AuditedNames was emitted, and its key landed in
    // neither AuditedNames nor the grandparent's class — while the generated code still
    // referenced it.
    private const string KeyOnlyModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Base", "abstract": true, "children": [
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "email", "@column": "zz_email_addr" } }
      ] } },
      { "object.entity": { "name": "Audited", "abstract": true, "extends": "Base", "children": [
        { "identity.secondary": { "name": "by_email", "@fields": ["email"] } }
      ] } },
      { "object.entity": { "name": "Widget", "extends": "Audited", "children": [
        { "source.rdb":       { "@table": "zz_widgets" } },
        { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
      ] } }
    ] } }
    """;

    [Fact]
    public void A_key_only_abstract_is_a_link_in_the_chain_not_a_node_to_walk_past()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(KeyOnlyModel, id: "keyonly.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig
            {
                OutDir = "/unused", Namespace = "Acme.Generated",
                ColumnNamingStrategy = ColumnNamingStrategy.SnakeCase, IncludeNames = true,
            },
        };
        var files = new NamesGenerator().Generate(ctx).ToDictionary(f => f.Path, f => f.Content);

        // The intermediate has something to contribute, so it gets a class of its own...
        Assert.True(files.ContainsKey("AuditedNames.g.cs"), string.Join(", ", files.Keys));
        Assert.Contains("by_email", files["AuditedNames.g.cs"]);

        // ...and the concrete entity reaches it by EXTENDING that class rather than
        // restating the key. Stated in the negative too: emitting both the base reference
        // AND the literal would satisfy a positive-only assertion while re-introducing the
        // duplication the class exists to remove.
        var widget = files["WidgetNames.g.cs"];
        Assert.Contains("class WidgetNames : AuditedNames", widget);
        Assert.DoesNotContain("\"by_email\"", widget);
    }

    [Fact]
    public void A_sourceless_object_nothing_persistable_extends_still_gets_nothing()
    {
        // #248 intact. The fragment is reached by walking `extends` UPWARD from a database
        // participant — the only context in which an object's fields are columns at all.
        // An object.value carrying fields is not reached, so it acquires no artifact and no
        // phantom participation. Without this the "abstract base" relaxation would have
        // quietly become "anything with fields".
        Assert.DoesNotContain("MoneyNames.g.cs", Generate().Keys);
    }

    [Fact]
    public void The_emitted_set_compiles_and_an_inherited_constant_resolves_through_the_base()
    {
        // The teeth. Every assertion above is about TEXT; only a compiler proves that
        // `AuthorNames.CreatedAtColumn` — a member the class no longer declares — still
        // resolves through the base, which is what every consumption site emits.
        var files = Generate();
        var probe = """
        namespace Acme.Generated;
        public static class Probe
        {
            // An INHERITED const, reached through the base class.
            public const string A = AuthorNames.CreatedAtColumn;
            // An inherited const from a TPH base, including the shared table name. A TPH
            // subtype declares no own source, so `SourcePrimaryTable` is the base's, reached
            // through the base class — not restated here.
            public const string B = CopayAuthNames.SourcePrimaryTable;
            public const string C = CopayAuthNames.CopayAmountColumn;
            // ColumnsByField stays COMPLETE on the subtype — it is the lookup surface, and a
            // miss on an inherited field is the fallback-to-literal this artifact removes.
            public static readonly int Count = CopayAuthNames.ColumnsByField.Count;
        }
        """;
        var trees = files.Values.Append(probe)
            .Select(src => CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToList();
        var comp = CSharpCompilation.Create(
            "names_extends_" + Guid.NewGuid().ToString("N"),
            trees, DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));

        // A clean compile proves the members resolve; this proves the SUBTYPE's dictionary
        // is the complete one rather than the base's (a static field is hidden, not
        // overridden, so `new` is what makes CopayAuthNames.ColumnsByField the 4-entry one).
        var sub = files["CopayAuthNames.g.cs"];
        Assert.Contains("public static new readonly Dictionary<string, string> ColumnsByField", sub);
        Assert.Contains("[\"id\"] = IdColumn,", sub);
        Assert.Contains("[\"copayAmount\"] = CopayAmountColumn,", sub);
    }

    [Fact]
    public void A_child_field_colliding_with_an_INHERITED_one_is_refused_naming_the_model()
    {
        // The guard has to see the WHOLE field set, not just what this class declares.
        // Once a child stopped declaring its inherited constants, an own-only check could no
        // longer see a collision that spans the inheritance boundary — and C# would not
        // catch it either: a derived `const string CreatedAtColumn` HIDES the base's rather
        // than clashing with it, so the file compiles (with a warning at most) while
        // ColumnsByField silently maps the INHERITED field name to the CHILD's column.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "BaseRow", "abstract": true, "children": [
            { "field.timestamp": { "name": "createdAt" } }
          ]}},
          { "object.entity": { "name": "Row", "extends": "BaseRow", "children": [
            { "source.rdb": { "@table": "rows" } },
            { "field.long":      { "name": "id" } },
            { "field.timestamp": { "name": "CreatedAt" } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "collide.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Generated", IncludeNames = true },
        };

        var ex = Assert.Throws<InvalidOperationException>(() => new NamesGenerator().Generate(ctx).ToList());
        Assert.Contains("createdAt", ex.Message);
        Assert.Contains("CreatedAt", ex.Message);
    }
}
