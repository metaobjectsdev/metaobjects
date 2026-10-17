using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Relationship;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Core.Relationship.RelationshipConstants;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port codegen conformance (C#) for ADR-0059 Decision 7. Loads
/// <c>fixtures/codegen-conformance/cross-package-binding/</c> and checks the decision table
/// <c>expected-bindings.json</c>: every reference binds the object the table names, and the
/// M:N / to-one resolution the generated EF Core and route code is built from lands on that
/// object's table, junction and join fields rather than on a same-short-named object in another
/// package (or in the package of the entity that inherits the attribute).
/// </summary>
public class CrossPackageBindingConformanceTests
{
    private static string FixtureDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "codegen-conformance", "cross-package-binding");
    }

    private static MetaRoot Load()
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(FixtureDir(), "input"));
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static JsonElement Expected(string section)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(FixtureDir(), "expected-bindings.json")));
        return doc.RootElement.GetProperty(section).Clone();
    }

    private static (MetaObject Owner, string Member) Split(string address)
    {
        int dot = address.LastIndexOf('.');
        return (default!, address[(dot + 1)..]);
    }

    private static MetaObject Entity(MetaRoot root, string resolutionKey) =>
        Assert.Single(root.Objects(), o => o.ResolutionKey() == resolutionKey);

    private static MetaObject OwnerOf(MetaRoot root, string address) =>
        Entity(root, address[..address.LastIndexOf('.')]);

    [Fact]
    public void Every_identity_reference_binds_the_object_the_table_names()
    {
        var root = Load();
        foreach (var entry in Expected("references").EnumerateObject())
        {
            var owner = OwnerOf(root, entry.Name);
            string member = Split(entry.Name).Member;
            var reference = Assert.Single(
                owner.ReferenceIdentities(), r => r.Name == member);
            var bound = NamingRefs.RefTarget(reference, IDENTITY_REFERENCE_ATTR_REFERENCES);
            Assert.True(bound is not null, $"{entry.Name} bound nothing");
            Assert.Equal(entry.Value.GetString(), bound!.ResolutionKey());
        }
    }

    [Fact]
    public void Every_relationship_resolves_to_the_target_table_junction_and_join_fields_the_table_names()
    {
        var root = Load();
        foreach (var entry in Expected("relations").EnumerateObject())
        {
            var owner = OwnerOf(root, entry.Name);
            string member = Split(entry.Name).Member;
            var expected = entry.Value;
            string label = entry.Name;

            if (expected.GetProperty("cardinality").GetString() == "many")
            {
                var nav = Assert.Single(
                    M2MNavigationBuilder.For(owner, root), n => n.Relationship.Name == member);
                Assert.Equal(expected.GetProperty("target").GetString(), nav.Target.ResolutionKey());
                Assert.Equal(expected.GetProperty("targetTable").GetString(), nav.Target.DbTable);
                Assert.Equal(expected.GetProperty("junction").GetString(), nav.Junction.ResolutionKey());
                Assert.Equal(expected.GetProperty("junctionTable").GetString(), nav.Junction.DbTable);
                Assert.Equal(expected.GetProperty("sourceJoinField").GetString(), nav.SourceField);
                Assert.Equal(expected.GetProperty("targetJoinField").GetString(), nav.TargetField);

                var fields = M2MDerivation.DeriveM2MFields(nav.Relationship, owner, root);
                Assert.Equal(nav.SourceField, fields.SourceField);
                Assert.Equal(nav.TargetField, fields.TargetField);
                continue;
            }

            var rel = Assert.Single(owner.Relationships(), r => r.Name == member);
            var target = NamingRefs.RefTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF);
            Assert.True(target is not null, $"{label} bound nothing");
            Assert.Equal(expected.GetProperty("target").GetString(), target!.ResolutionKey());
            Assert.Equal(expected.GetProperty("targetTable").GetString(), ((MetaObject)target).DbTable);

            var reference = RelationshipReferences.ResolveRelationshipReference(
                owner, rel.Name, target, rel.SourceRefField);
            Assert.True(reference is not null, $"{label} paired no identity.reference");
            Assert.Equal(expected.GetProperty("fkField").GetString(), reference!.Fields[0]);
        }
    }

    private static Dictionary<string, string> Generated(MetaRoot root)
    {
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" },
        };
        var files = new Dictionary<string, string>();
        foreach (var gen in new IGenerator[] { new EntityGenerator(), new DbContextGenerator(), new RoutesGenerator() })
            foreach (var file in gen.Generate(ctx))
                files.TryAdd(file.Path, file.Content);
        return files;
    }

    [Fact]
    public void Generated_routes_and_entities_use_the_bound_target_of_each_navigation()
    {
        var root = Load();
        var files = Generated(root);
        string navigating = string.Concat(
            files["Post.g.cs"], files["PostRoutes.g.cs"], files["Order.g.cs"], files["OrderRoutes.g.cs"], files["AppDbContext.g.cs"]);

        // The same-short-named objects in the wrong package own a string key and these tables.
        Assert.DoesNotContain("a_tags", navigating);
        Assert.DoesNotContain("acme_labels", navigating);
        Assert.DoesNotContain("acme_customers", navigating);
        Assert.DoesNotContain("EF.Property<string>", navigating);

        string post = files["PostRoutes.g.cs"];
        Assert.Contains("/posts/{id}/tags", post);
        Assert.Contains("relatedIds.Contains(EF.Property<long>(t, \"Id\"))", post);
        Assert.DoesNotContain("\"Code\"", post);
        Assert.Contains("ICollection<Tag> Tags", files["Post.g.cs"]);
        Assert.Contains("FeaturedTagId", files["Post.g.cs"]);

        string order = files["OrderRoutes.g.cs"];
        Assert.Contains("/orders/{id}/labels", order);
        Assert.Contains("relatedIds.Contains(EF.Property<long>(t, \"Id\"))", order);
        Assert.DoesNotContain("\"Code\"", order);
        string orderEntity = files["Order.g.cs"];
        Assert.Contains("ICollection<Label> Labels", orderEntity);
        Assert.Contains("public long? CustomerId", orderEntity);

        string dbContext = files["AppDbContext.g.cs"];
        Assert.Contains("modelBuilder.Entity<Post>().HasMany(x => x.Tags).WithMany().UsingEntity<PostTag>(", dbContext);
        Assert.Contains("modelBuilder.Entity<Order>().HasMany(x => x.Labels).WithMany().UsingEntity<OrderLabel>(", dbContext);
        Assert.Contains("l.HasOne<Label>().WithMany().HasForeignKey(j => j.LabelId)", dbContext);
        Assert.Contains("modelBuilder.Entity<Order>().HasOne<Customer>().WithMany().HasForeignKey(e => e.CustomerId)", dbContext);
        Assert.Contains("modelBuilder.Entity<Post>().HasOne<Tag>().WithMany().HasForeignKey(e => e.FeaturedTagId)", dbContext);
    }
}
