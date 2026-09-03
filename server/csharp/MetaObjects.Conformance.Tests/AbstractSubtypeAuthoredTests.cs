// An authored `<type>.base` is refused — every base subtype is an abstract anchor.
//
// Every registered `base` subtype is the shared root that concrete subtypes inherit their
// attrs and child rules from. It has no runtime semantics and no concrete representation:
// spec/metamodel/object.json says so in as many words ("Has no runtime semantics of its
// own; not authored directly"), and every `base` entry's description in the byte-gated
// registry manifest opens with "Abstract".
//
// The JVM enforced this by accident — its impl classes are `public abstract`, so
// instantiating one failed — while TypeScript, C# and Python accepted it outright. The same
// document therefore loaded on three ports and failed to load on two, which is exactly the
// cross-port conformance gap the corpora exist to catch. It survived because every `*.base`
// subtype sits in the registry corpus's own `untestedSubTypes` list;
// fixtures/conformance/error-abstract-subtype-authored closes that.

using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class AbstractSubtypeAuthoredTests
{
    private static LoadResult Load(string node) =>
        new MetaDataLoader().Load([new InMemoryStringSource(
            $$"""{ "metadata.root": { "package": "acme", "children": [ {{node}} ] } }""",
            id: "base.json")]);

    // Every registered base subtype, authored in a position its type is legal in.
    [Theory]
    [InlineData("object.base", """{ "object.base": { "name": "P", "children": [ { "field.long": { "name": "id" } } ] } }""")]
    [InlineData("field.base", """{ "object.entity": { "name": "E1", "children": [ { "field.base": { "name": "f" } } ] } }""")]
    [InlineData("source.base", """{ "object.entity": { "name": "E2", "children": [ { "source.base": { "name": "s" } }, { "field.long": { "name": "id" } } ] } }""")]
    [InlineData("validator.base", """{ "object.entity": { "name": "E3", "children": [ { "field.string": { "name": "s", "children": [ { "validator.base": { "name": "v" } } ] } } ] } }""")]
    [InlineData("view.base", """{ "object.entity": { "name": "E4", "children": [ { "field.string": { "name": "s", "children": [ { "view.base": { "name": "v" } } ] } } ] } }""")]
    [InlineData("attr.base", """{ "object.entity": { "name": "E5", "children": [ { "field.string": { "name": "s", "children": [ { "attr.base": { "name": "a", "value": "x" } } ] } } ] } }""")]
    public void An_authored_base_subtype_is_refused(string label, string node)
    {
        var result = Load(node);
        var err = Assert.Single(result.Errors, e => e.Code == ErrorCode.ERR_ABSTRACT_SUBTYPE_AUTHORED);
        Assert.Contains(label, err.Message);
        Assert.Contains("abstract registry anchor", err.Message);
    }

    // The OTHER spelling. A BARE wrapper key omits the subType, so the type's DECLARED
    // default decides — the same accessor the YAML desugar consults, whose contract the shared
    // corpus already pins (yaml-bare-default-subtypes: bare `object:` becomes `object.entity`).
    // Only a type declaring NO default is refused, and then with ERR_MISSING_SUBTYPE: the
    // author omitted a subType, they did not author an anchor.
    //
    // Four ports gave three answers here. This one and TypeScript GUESSED (registration order,
    // falling back to `base`) and loaded the anchor; the JVM guessed the same way and then
    // failed to instantiate it; Python refused every bare key outright, so raw JSON and
    // desugared YAML meant different things there.
    [Theory]
    [InlineData("field", """{ "object.entity": { "name": "B1", "children": [ { "field": { "name": "f" } } ] } }""")]
    [InlineData("source", """{ "object.entity": { "name": "B2", "children": [ { "source": { "name": "s" } }, { "field.long": { "name": "id" } } ] } }""")]
    [InlineData("view", """{ "object.entity": { "name": "B3", "children": [ { "field.string": { "name": "s", "children": [ { "view": { "name": "v" } } ] } } ] } }""")]
    public void A_bare_wrapper_key_resolving_to_the_anchor_is_refused(string label, string node)
    {
        var result = Load(node);
        var err = Assert.Single(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_SUBTYPE);
        Assert.Contains(label, err.Message);
        Assert.Contains("has no default subType", err.Message);
    }

    [Fact]
    public void A_bare_object_key_still_resolves_to_object_entity()
    {
        // The control the refusal above must not swallow. `object` DECLARES a default, and
        // the YAML corpus pins bare `object:` to `object.entity` cross-port; a JSON bare key
        // has to agree, or the two input formats mean different things.
        var result = Load("""{ "object": { "name": "Product", "children": [ { "field.string": { "name": "sku" } } ] } }""");
        Assert.Empty(result.Errors);
        var product = Assert.Single(result.Root.Objects(), o => o.Name == "Product");
        Assert.Equal("entity", product.SubType);
    }

    [Fact]
    public void The_concrete_sibling_of_every_refused_case_still_loads()
    {
        // The control arm. Without it, a check that refused every node would pass above.
        var result = Load("""
        { "object.entity": { "name": "Fine", "children": [
          { "source.rdb": { "name": "primary", "@table": "fines" } },
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "s", "children": [ { "validator.required": {} } ] } },
          { "field.currency": { "name": "price", "@currency": "USD", "children": [
            { "view.currency": { "name": "v" } }
          ] } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
        """);
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void An_inline_default_still_reaches_the_polymorphic_attr_subtype()
    {
        // `attr.base` is REAL — it is what an untyped `@default` resolves to, with its value
        // type following the owning field. The loader picks it; an author never names it. The
        // rule refuses the authored spelling and must leave this path alone.
        var result = Load("""
        { "object.entity": { "name": "Item", "children": [
          { "source.rdb": { "name": "primary", "@table": "items" } },
          { "field.long": { "name": "id" } },
          { "field.boolean": { "name": "enabled", "@default": false } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
        """);
        Assert.Empty(result.Errors);
        var item = Assert.Single(result.Root.Objects(), o => o.Name == "Item");
        var enabled = Assert.Single(item.Fields(), f => f.Name == "enabled");
        Assert.Equal(false, enabled.Attr("default"));
    }
}
