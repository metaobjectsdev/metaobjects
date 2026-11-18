using MetaObjects.Meta;
using MetaObjects.Shared;

namespace MetaObjects.TestVocabulary;

/// <summary>Registers <c>layout.picker</c> and extends <c>field.string</c> with <c>@searchable</c>.</summary>
public sealed class TestVocabularyProvider : IMetaDataTypeProvider
{
    public string Id => "test-vocabulary";
    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId("layout", "picker"),
            description: "A picker that chooses one row of the owning object.",
            childRules: [new ChildRule(BaseTypes.TYPE_ATTR, Structural.CHILD_RULE_WILDCARD, Structural.CHILD_RULE_WILDCARD)],
            factory: (typeId, name) => new MetaLayout(typeId, name),
            attributes: [new AttrSchema("displayField", "string", Required: false, Description: "Field shown for each choice.")]));
        registry.Extend("field", "string",
            attributes: [new AttrSchema("searchable", "boolean", Required: false, Description: "Offer this field in search.")]);
    }
}

/// <summary>No public parameterless constructor: refused by the loader.</summary>
public sealed class NeedsArgsProvider(string x) : IMetaDataTypeProvider
{
    public string Id => x;
    public IReadOnlyList<string> Dependencies => [];
    public void RegisterTypes(TypeRegistry registry) { }
}

/// <summary>Not a provider at all.</summary>
public sealed class NotAProvider { }
