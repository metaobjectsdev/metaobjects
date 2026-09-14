// Follow-up to #368 — M:N derivation used the VISITING entity, not the entity that
// DECLARES the relationship.
//
// M2MNavigationBuilder.For walks the RESOLVING Relationships(), so a M:N declared on
// an abstract base is reached again through every entity that extends it, with the
// INHERITING entity as `source`. M2MDerivation then compared @objectRef against that
// entity: an inherited self-join read as hetero, looked for a junction reference to
// the child, found none and threw — and M2MNavigationBuilder.Build CATCHES
// M2MDerivationException and returns null, so the navigation vanished from the
// generated entity, DbContext and routes with no error at all.
//
// Both authoring shapes must work: the junction FK may reference the declaring BASE,
// or (more usually) the CONCRETE child, since the abstract base has no table. The
// counter-case test below guards the second.
//
// The child is declared BEFORE the base so the walk reaches it first — the order
// shape the #368 loader regressions established. (DbContextGenerator additionally
// sorts entities by name, and "Node" < "NodeBase" ordinally, so that path sees the
// child first too.)

using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Relationship;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class M2MInheritedDeclaringEntityTests
{
    // NodeBase declares a @symmetric self-join onto ITSELF; the junction references
    // the BASE. Node extends it and is declared first.
    private const string SelfJoinModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Node", "extends": "NodeBase", "children": [
        { "source.rdb": { "@table": "nodes" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "NodeBase", "@isAbstract": true, "children": [
        { "relationship.association": { "name": "peers", "@cardinality": "many", "@objectRef": "NodeBase", "@through": "NodeLink", "@symmetric": true } }
      ]}},
      { "object.entity": { "name": "NodeLink", "children": [
        { "source.rdb": { "@table": "node_links" } },
        { "field.long": { "name": "aId" } },
        { "field.long": { "name": "bId" } },
        { "identity.primary": { "@fields": ["aId", "bId"] } },
        { "identity.reference": { "name": "fkA", "@fields": "aId", "@references": "NodeBase" } },
        { "identity.reference": { "name": "fkB", "@fields": "bId", "@references": "NodeBase" } }
      ]}}
    ]}}
    """;

    // ArticleBase declares a HETERO M:N; the junction references the BASE.
    private const string HeteroBaseRefModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Article", "extends": "ArticleBase", "children": [
        { "source.rdb": { "@table": "articles" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "ArticleBase", "@isAbstract": true, "children": [
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "ArticleTag" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "ArticleTag", "children": [
        { "source.rdb": { "@table": "article_tags" } },
        { "field.long": { "name": "articleId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["articleId", "tagId"] } },
        { "identity.reference": { "name": "fkArticle", "@fields": "articleId", "@references": "ArticleBase" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}}
    ]}}
    """;

    // The other legitimate shape: the junction references the CONCRETE child.
    private const string HeteroConcreteRefModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Post", "extends": "PostBase", "children": [
        { "source.rdb": { "@table": "posts" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "PostBase", "@isAbstract": true, "children": [
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "PostTag", "children": [
        { "source.rdb": { "@table": "post_tags" } },
        { "field.long": { "name": "postId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["postId", "tagId"] } },
        { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "inherited-m2m.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static MetaRelationship Rel(MetaObject entity, string name) =>
        entity.Relationships().Single(r => r.Name == name);

    [Fact]
    public void Derive_inherited_self_join_uses_the_declaring_entity()
    {
        var root = Load(SelfJoinModel);
        // Pin the premise: the child is walked before the base it inherits from.
        Assert.Equal(["Node", "NodeBase", "NodeLink"], root.Objects().Select(o => o.Name).ToArray());

        var node = root.FindObject("Node")!;
        var rel = Rel(node, "peers");
        Assert.Empty(node.OwnRelationships());              // genuinely inherited
        Assert.Equal("NodeBase", (rel.Parent as MetaObject)!.Name);

        var fields = M2MDerivation.DeriveM2MFields(rel, node, root);
        Assert.Equal("aId", fields.SourceField);
        Assert.Equal("bId", fields.TargetField);
        // The declaring entity itself must agree — same node, same answer.
        Assert.Equal(fields, M2MDerivation.DeriveM2MFields(rel, root.FindObject("NodeBase")!, root));
    }

    [Fact]
    public void Derive_inherited_hetero_matches_the_bases_junction_reference()
    {
        var root = Load(HeteroBaseRefModel);
        var article = root.FindObject("Article")!;
        var fields = M2MDerivation.DeriveM2MFields(Rel(article, "tags"), article, root);
        Assert.Equal("articleId", fields.SourceField);
        Assert.Equal("tagId", fields.TargetField);
    }

    [Fact]
    public void Derive_inherited_hetero_matches_a_concrete_junction_reference()
    {
        // Counter-case: accepting ONLY the declaring entity would break this shape,
        // which is the common one (the abstract base has no table).
        var root = Load(HeteroConcreteRefModel);
        var post = root.FindObject("Post")!;
        var rel = Rel(post, "tags");
        Assert.Equal("PostBase", (rel.Parent as MetaObject)!.Name);
        var fields = M2MDerivation.DeriveM2MFields(rel, post, root);
        Assert.Equal("postId", fields.SourceField);
        Assert.Equal("tagId", fields.TargetField);
    }

    // ADR-0041 DIVERGENCE — pinned, not fixed. Java's M2MFields compares RESOLVED object
    // identity (FQN-exact); C#, TS and Python compare StripPackage() short names. The
    // subject set used to hold one short name and now holds two, so the surface on which
    // a bare-name compare can mis-bind is twice as large. Here a::NodeBase declares a
    // genuine CROSS-PACKAGE hetero M:N onto b::NodeBase and a::Node extends a::NodeBase:
    // deriving from a::Node the subject short names are {"NodeBase", "Node"}, and
    // "b::NodeBase" strips to "NodeBase", so the target reads as the subject and the
    // relationship is misclassified as an ambiguous self-join. Java's equivalent
    // (M2MSlimVocabularyTest.deriveCrossPackageHeteroBindsCorrectPackage) gets it right.
    //
    // Honest about severity: this model derived CORRECTLY before this branch (the
    // one-member subject set did not collide), so the widening regressed it. Accepted
    // deliberately per the ADR-0041 split. This encodes what C# ACTUALLY does so the
    // divergence is gated rather than latent; when C# adopts FQN-exactness this test
    // fails and must be rewritten to assert srcId/dstId.
    private const string XpkgAModel = """
    { "metadata.root": { "package": "a", "children": [
      { "object.entity": { "name": "Node", "extends": "a::NodeBase", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "NodeBase", "@isAbstract": true, "children": [
        { "relationship.association": { "name": "links", "@cardinality": "many", "@objectRef": "b::NodeBase", "@through": "L" } }
      ]}},
      { "object.entity": { "name": "L", "children": [
        { "field.long": { "name": "srcId" } },
        { "field.long": { "name": "dstId" } },
        { "identity.primary": { "@fields": ["srcId", "dstId"] } },
        { "identity.reference": { "name": "s", "@fields": "srcId", "@references": "a::Node" } },
        { "identity.reference": { "name": "d", "@fields": "dstId", "@references": "b::NodeBase" } }
      ]}}
    ]}}
    """;

    private const string XpkgBModel = """
    { "metadata.root": { "package": "b", "children": [
      { "object.entity": { "name": "NodeBase", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Adr0041_gap_cross_package_target_sharing_a_subject_short_name()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(XpkgAModel, id: "a.json"),
            new InMemoryStringSource(XpkgBModel, id: "b.json"),
        ]);
        // The model itself is perfectly legal — the loader raises nothing.
        Assert.Empty(r.Errors);
        var node = r.Root.Objects().First(o => o.Name == "Node");
        var rel = Rel(node, "links");

        // CURRENT C# BEHAVIOUR (wrong; Java derives srcId/dstId here):
        var ex = Assert.Throws<M2MDerivationException>(
            () => M2MDerivation.DeriveM2MFields(rel, node, r.Root));
        Assert.Contains("is ambiguous", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Navigation_builder_emits_the_inherited_self_join_and_flags_it()
    {
        var root = Load(SelfJoinModel);
        var node = root.FindObject("Node")!;

        // Was: Build caught M2MDerivationException and returned null -> empty list.
        var nav = Assert.Single(M2MNavigationBuilder.For(node, root));
        Assert.Equal("peers", nav.Name);
        Assert.Equal("NodeLink", nav.Junction.Name);
        Assert.Equal("aId", nav.SourceField);
        Assert.Equal("bId", nav.TargetField);
        Assert.True(nav.Symmetric);

        // IsSelfJoin must compare against the DECLARING entity too: Source is the
        // inheriting "Node" while Target is "NodeBase". This is exactly the filter
        // DbContextGenerator applies — a false here would emit EF UsingEntity wiring
        // for a self-join, turning the old silent drop into silently wrong output.
        Assert.Equal("Node", nav.Source.Name);
        Assert.Equal("NodeBase", nav.Target.Name);
        Assert.Equal("NodeBase", nav.DeclaringEntity.Name);
        Assert.True(nav.IsSelfJoin);
        Assert.DoesNotContain(M2MNavigationBuilder.For(node, root), n => !n.IsSelfJoin);
    }

    [Fact]
    public void Navigation_builder_emits_the_inherited_hetero_navigation()
    {
        var root = Load(HeteroBaseRefModel);
        var article = root.FindObject("Article")!;
        var nav = Assert.Single(M2MNavigationBuilder.For(article, root));
        Assert.Equal("tags", nav.Name);
        Assert.Equal("Tag", nav.Target.Name);
        Assert.Equal("articleId", nav.SourceField);
        Assert.Equal("tagId", nav.TargetField);
        Assert.False(nav.IsSelfJoin);
    }
}
