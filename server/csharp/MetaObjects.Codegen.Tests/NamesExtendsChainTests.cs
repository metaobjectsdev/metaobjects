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
        // It declares no source. A `Name` here would be a physical name invented for an
        // object that declares none — the phantom-table failure #248 exists to prevent.
        Assert.DoesNotContain("public const string Name =", src);
        Assert.DoesNotContain("public const string Kind =", src);
        Assert.DoesNotContain("public const bool ReadOnly =", src);
    }

    [Fact]
    public void The_child_extends_the_base_and_declares_only_its_own_column()
    {
        var src = Generate()["AuthorNames.g.cs"];
        Assert.Contains("public abstract class AuthorNames : BaseEntityNames", src);
        Assert.Contains("public const string EmailColumn = \"zz_email_addr\";", src);
        // Its own source, so its own physical name.
        Assert.Contains("public const string Name = \"zz_authors\";", src);
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
            // An inherited const from a TPH base, including the shared table name.
            public const string B = CopayAuthNames.Name;
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
