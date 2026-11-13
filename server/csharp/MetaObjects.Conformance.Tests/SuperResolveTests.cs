using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SuperResolveTests
{
    [Fact]
    public void Single_level_extends_resolves_and_inherits_fields()
    {
        var result = MetaDataLoader.FromDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "extends-single-level", "input"));
        Assert.Empty(result.Errors);
        // the subtype's effective fields include the base's fields (inherited via the resolved super chain)
        var sub = result.Root.OwnChildren().First(c => c.SuperData != null);
        Assert.True(sub.Children().Count > sub.OwnChildren().Count);
    }

    [Fact]
    public void Nonexistent_extends_collects_ERR_UNRESOLVED_SUPER()
    {
        var result = MetaDataLoader.FromDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, "error-extends-nonexistent", "input"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNRESOLVED_SUPER);
    }

    // rc.21 (U1): a projection over a TPH root anchors its identity on the root's identity, which the
    // root inherits from an abstract base in another package. The identity is unnamed, so it is
    // named "primary": `Authorization.primary` resolves through the inherited member, and
    // `Authorization.id` (the identity spelled by its field) names the members it could have meant.
    private static string U1Model(string target) => """
        { "metadata.root": { "package": "acme::common", "children": [
          { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
            { "field.int": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } } ] } }
        """ + "\u0000" + """
        { "metadata.root": { "package": "acme::auth", "children": [
          { "object.entity": { "name": "Authorization", "extends": "acme::common::BaseEntity", "@discriminator": "kind", "children": [
            { "source.rdb": { "@table": "authorizations" } },
            { "field.string": { "name": "kind" } } ] } },
          { "object.entity": { "name": "PriorAuth", "extends": "Authorization", "@discriminatorValue": "Prior", "children": [
            { "field.string": { "name": "key" } } ] } },
          { "object.projection": { "name": "AuthView", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_auth" } },
            { "field.int": { "name": "id", "extends": "Authorization.id" } },
            { "field.string": { "name": "key", "extends": "PriorAuth.key" } },
            { "identity.primary": { "extends": "TARGET" } } ] } } ] } }
        """.Replace("TARGET", target);

    private static LoadResult LoadU1(string target)
    {
        var parts = U1Model(target).Split('\u0000');
        return new MetaDataLoader(FullCoreRegistry.Compose(), strict: true).Load([new InMemoryStringSource(parts[0], id: "common.json"), new InMemoryStringSource(parts[1], id: "auth.json")]);
    }

    [Fact]
    public void A_dotted_extends_resolves_an_identity_the_owner_inherits()
    {
        var result = LoadU1("Authorization.primary");
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void A_dotted_extends_naming_a_missing_member_lists_the_owners_members()
    {
        var error = Assert.Single(LoadU1("Authorization.id").Errors, e => e.Code == ErrorCode.ERR_UNRESOLVED_SUPER);
        Assert.Contains("'acme::auth::Authorization' has no identity named \"id\"; its identity children are: \"primary\" (identity.primary).", error.Message);
        Assert.Contains("An identity.primary declared without a name is named \"primary\".", error.Message);
        // The owner was found, so the same-named-object FQN advice would be wrong.
        Assert.DoesNotContain("Qualify it with its package", error.Message);
    }
}
