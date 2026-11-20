// The metaobjects-view-expressions pack (new in 1.3.0): origin.function (a value computed by
// a database function the project owns) and the projection shape attrs @union / @unionAll /
// @grain / @grainOrdinal. Its own provider so a project can leave it out; it is in the
// default bundle, so every existing model loads unchanged. Types and attrs are declared in
// the embedded view-expressions.json. Mirrors the TS viewExpressionsProvider.

using MetaObjects.Meta;
using MetaObjects.Persistence.Origin;
using MetaObjects.Registry.Spec;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Persistence.ViewExpressions;

/// <summary>The view-expressions pack provider (<c>metaobjects-view-expressions</c>).</summary>
public sealed class ViewExpressionsMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry.</summary>
    public static readonly IMetaDataTypeProvider Instance = new ViewExpressionsMetaDataProvider();

    /// <summary>The provider id — matches view-expressions.json's <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-view-expressions";

    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "View expressions: origin.function and the projection @union / @unionAll / @grain / @grainOrdinal attrs.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        registry.Register(new TypeDefinition(
            typeId: new TypeId(TYPE_ORIGIN, OriginConstants.ORIGIN_SUBTYPE_FUNCTION),
            description: $"Origin ({OriginConstants.ORIGIN_SUBTYPE_FUNCTION})",
            childRules: [new ChildRule(TYPE_ATTR, CHILD_RULE_WILDCARD, CHILD_RULE_WILDCARD)],
            factory: (tid, n) => new MetaOrigin(tid, n),
            attributes: OriginSchema.OriginAttrsMap[OriginConstants.ORIGIN_SUBTYPE_FUNCTION].ToList()));

        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal));
    }
}
