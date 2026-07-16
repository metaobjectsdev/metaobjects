using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Issue #205 — a <c>field.enum</c> on an <c>object.value</c> POCO must emit the mapped
/// enum type (resolving a <c>@provided</c> enum through <c>PackageNamespaces</c>), NOT
/// scalar <c>string</c>. The same field on an <c>object.entity</c> already resolves; the
/// value-object POCO path must not diverge. <c>EmitValueObjectPoco</c> routes enum fields
/// through the same <c>EnumProperty</c> → <c>EnumPropertyTypeName</c> resolution.
/// </summary>
public class Issue205ValueObjectEnumTests
{
    // A @provided abstract enum in one package, referenced by a value object's field via
    // a cross-package extends, and that value object owned (jsonb) by an entity so it is
    // emitted as a POCO.
    private const string ProvidedEnum = """
    { "metadata.root": { "package": "p3::common", "children": [
      { "field.enum": { "name": "ContactMethod", "abstract": true, "@provided": true, "@values": ["Phone","Email","Fax"] } }
    ]}}
    """;

    private const string EntityAndVo = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "contactInfo", "@objectRef": "acme::ContactInfo", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "ContactInfo", "children": [
        { "field.enum": { "name": "contactMethod", "@required": true, "extends": "p3::common::ContactMethod" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(ProvidedEnum, id: "enum.json"),
            new InMemoryStringSource(EntityAndVo, id: "model.json"),
        ]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp",
            Namespace = "Acme.Generated",
            PackageNamespaces = new() { ["p3::common"] = "Acme.DataEnums" },
        },
    };

    [Fact]
    public void ValueObject_enum_field_emits_provided_enum_type_not_string()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var vo = Assert.Single(files, f => f.Path == "ContactInfo.g.cs");
        var src = vo.Content;

        // The property is typed by the provided enum (resolved via PackageNamespaces),
        // NOT scalar string.
        Assert.DoesNotContain("public string ContactMethod", src);
        Assert.Contains("ContactMethod ContactMethod { get; set; }", src);
        // The resolved reference binds to the configured package namespace.
        Assert.Contains("Acme.DataEnums.ContactMethod", src);
    }
}
