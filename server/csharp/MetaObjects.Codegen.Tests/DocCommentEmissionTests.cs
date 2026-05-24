// DocCommentEmissionTests — verifies that XML-doc blocks and [Obsolete] attributes are
// emitted on entity classes, field properties, and DbSet properties. Also verifies the
// D5 contract: @notes content never reaches any generated output.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class DocCommentEmissionTests
{
    // -------------------------------------------------------------------------
    // Helpers — mirror EntityGeneratorTests setup exactly.
    // -------------------------------------------------------------------------

    private static MetaRoot Load(string json)
    {
        var r = new MetaDataLoader().Load([new InMemorySource(json, id: "test.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static string GenerateEntity(string json)
    {
        var root = Load(json);
        var ctx = Ctx(root);
        var files = new EntityGenerator().Generate(ctx).ToList();
        // Return the first non-value-object file.
        return files.First(f => !f.Path.StartsWith("Address") && !f.Path.StartsWith("Config")).Content;
    }

    private static string GenerateDbContext(string json)
    {
        var root = Load(json);
        var ctx = Ctx(root);
        return new DbContextGenerator().Generate(ctx).Single().Content;
    }

    // -------------------------------------------------------------------------
    // Task 6.1 — entity class XML doc
    // -------------------------------------------------------------------------

    [Fact]
    public void Entity_class_emits_summary_from_description()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "@description": "A registered account holder.",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>A registered account holder.</summary>", src);
        Assert.Contains("public class User", src);
        // The summary must appear before the class declaration.
        int summaryIdx = src.IndexOf("/// <summary>A registered account holder.</summary>", StringComparison.Ordinal);
        int classIdx   = src.IndexOf("public class User", StringComparison.Ordinal);
        Assert.True(summaryIdx < classIdx, "summary comment must precede the class declaration");
    }

    [Fact]
    public void Entity_class_emits_summary_from_title_when_no_description()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "@title": "Registered User",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>Registered User</summary>", src);
    }

    [Fact]
    public void Field_property_emits_summary()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long": { "name": "id" } },
              { "field.string": {
                  "name": "email",
                  "@description": "Primary email address."
              }},
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>Primary email address.</summary>", src);
        // Must precede the Email property.
        int summaryIdx = src.IndexOf("/// <summary>Primary email address.</summary>", StringComparison.Ordinal);
        int propIdx    = src.IndexOf("public string? Email", StringComparison.Ordinal);
        Assert.True(summaryIdx < propIdx, "field summary must precede the property declaration");
    }

    [Fact]
    public void Field_property_emits_Obsolete_with_replacedBy()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long": { "name": "id" } },
              { "field.string": {
                  "name": "email",
                  "@description": "Primary email.",
                  "@deprecated": "Use contactEmail.",
                  "@replacedBy": "User.contactEmail"
              }},
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>Primary email.</summary>", src);
        Assert.Contains("[Obsolete(\"Use contactEmail. Replaced by User.contactEmail.\")]", src);
    }

    [Fact]
    public void Field_Obsolete_without_replacedBy_uses_deprecated_message_only()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long": { "name": "id" } },
              { "field.string": {
                  "name": "email",
                  "@deprecated": "No longer used."
              }},
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("[Obsolete(\"No longer used.\")]", src);
        Assert.DoesNotContain("Replaced by", src);
    }

    [Fact]
    public void Description_with_ampersand_and_angle_brackets_is_xml_escaped()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "@description": "A & B < C > D",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>A &amp; B &lt; C &gt; D</summary>", src);
    }

    [Fact]
    public void No_doc_attrs_produces_no_xml_doc_lines()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.DoesNotContain("/// <summary>", src);
        Assert.DoesNotContain("[Obsolete", src);
    }

    // -------------------------------------------------------------------------
    // D5 contract — @notes MUST NOT appear in any generated output
    // -------------------------------------------------------------------------

    [Fact]
    public void Notes_content_NEVER_appears_in_emitted_entity_source()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "U",
            "@description": "Public.",
            "@notes": "__INTERNAL_MARKER__",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.DoesNotContain("__INTERNAL_MARKER__", src);
    }

    [Fact]
    public void Notes_content_NEVER_appears_in_emitted_field_source()
    {
        var src = GenerateEntity("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "U",
            "children": [
              { "field.long": { "name": "id" } },
              { "field.string": { "name": "email", "@notes": "__FIELD_INTERNAL__" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.DoesNotContain("__FIELD_INTERNAL__", src);
    }

    // -------------------------------------------------------------------------
    // Task 6.2 — DbSet XML doc
    // -------------------------------------------------------------------------

    [Fact]
    public void DbContext_DbSet_emits_summary_from_entity_description()
    {
        var src = GenerateDbContext("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "@description": "A registered account holder.",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.Contains("/// <summary>A registered account holder.</summary>", src);
        // Summary must precede the DbSet property.
        int summaryIdx = src.IndexOf("/// <summary>A registered account holder.</summary>", StringComparison.Ordinal);
        int dbsetIdx   = src.IndexOf("public DbSet<User> Users", StringComparison.Ordinal);
        Assert.True(summaryIdx < dbsetIdx, "summary comment must precede DbSet property");
    }

    [Fact]
    public void DbContext_DbSet_no_doc_attrs_emits_no_xml_doc()
    {
        var src = GenerateDbContext("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.DoesNotContain("/// <summary>", src);
    }

    [Fact]
    public void DbContext_DbSet_notes_NEVER_appears()
    {
        var src = GenerateDbContext("""
        { "metadata.root": { "children": [{
          "object.entity": {
            "name": "User",
            "@description": "Public.",
            "@notes": "__DBSET_INTERNAL__",
            "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }
        }]}}
        """);
        Assert.DoesNotContain("__DBSET_INTERNAL__", src);
    }
}
