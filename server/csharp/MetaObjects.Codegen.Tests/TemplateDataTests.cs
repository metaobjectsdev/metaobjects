using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MetaObjects.Codegen.TemplateCodegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TemplateDataTests
{
    private static string Corpus()
    {
        var root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "template-codegen-conformance")))
            root = Path.GetDirectoryName(root) ?? throw new InvalidOperationException("corpus not found");
        return Path.Combine(root, "fixtures", "template-codegen-conformance");
    }

    private static IReadOnlyList<MetaObject> Objects() =>
        MetaDataLoader.FromDirectory(Path.Combine(Corpus(), "metadata")).Root.Objects();

    private static MetaObject Obj(string name) =>
        Objects().First(o => o.Name == name);

    [Fact]
    public void EntityDictNeutralFields()
    {
        var d = TemplateData.Entity(Obj("Product"));
        Assert.Equal("Product", d["name"]);
        Assert.Equal("shop", d["package"]);

        var fields = ((List<Dictionary<string, object?>>)d["fields"]!)
            .ToDictionary(f => (string)f["name"]!, f => f);
        Assert.Equal("string", fields["name"]["type"]);
        Assert.Equal(true, fields["name"]["required"]);
        Assert.Equal(false, fields["name"]["isArray"]);
        Assert.Equal(120, fields["name"]["maxLength"]);
        Assert.Equal("enum", fields["status"]["type"]);
        Assert.Equal(new List<string> { "ACTIVE", "ARCHIVED" }, fields["status"]["enumValues"]);
        // id has no maxLength/enumValues — keys ABSENT
        Assert.False(fields["id"].ContainsKey("maxLength"));
        Assert.False(fields["id"].ContainsKey("enumValues"));
    }

    [Fact]
    public void OrderRelationship()
    {
        var d = TemplateData.Entity(Obj("Order"));
        var rels = (List<Dictionary<string, object?>>)d["relationships"]!;
        Assert.Single(rels);
        Assert.Equal("product", rels[0]["name"]);
        Assert.Equal("one", rels[0]["cardinality"]);
        Assert.Equal("Product", rels[0]["targetRef"]);
    }

    [Fact]
    public void ModelGroupsByPackage()
    {
        var model = TemplateData.Model(Objects());
        var pkgs = (List<Dictionary<string, object?>>)model["packages"]!;
        Assert.Single(pkgs);
        Assert.Equal("shop", pkgs[0]["package"]);
        Assert.Equal(2, ((List<Dictionary<string, object?>>)pkgs[0]["entities"]!).Count);
    }
}
