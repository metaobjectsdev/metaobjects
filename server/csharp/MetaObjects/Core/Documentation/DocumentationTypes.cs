// Documentation provider — registers the 7 universal doc common attrs.
//
// Colocated per ADR-0003. Mirrors
// typescript/packages/metadata/src/core/documentation/documentation-types.ts.

namespace MetaObjects.Core.Documentation;

/// <summary>
/// Documentation provider — registers the 7 universal doc common attrs.
/// One provider per package; depends on metaobjects-core-types per ADR-0004.
/// </summary>
public static class DocumentationTypes
{
    public static readonly IMetaDataTypeProvider DocTypesProvider = new DocTypesProviderImpl();

    private sealed class DocTypesProviderImpl : IMetaDataTypeProvider
    {
        public string Id => "metaobjects-documentation";
        public string? Description => "Universal documentation common attrs accepted on every metatype.";
        public IReadOnlyList<string> Dependencies => new[] { "metaobjects-core-types" };

        public void RegisterTypes(TypeRegistry registry) =>
            registry.RegisterCommonAttrs(DocumentationSchema.CommonDocAttrs);
    }
}
