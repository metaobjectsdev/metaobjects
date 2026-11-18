// The metaobjects-ui-web concern provider.
//
// Registers the web presentation view attrs declared in the embedded
// spec/metamodel/ui-web.json `extends` directives: view.textarea @rows and the
// view.image control's @aspectRatio / @maxEdge / @store / @accept / @maxBytes.
// They are cross-port vocabulary only TypeScript implements so far (view.json marks
// the types `implementedIn: ["typescript"]`): C# registers them so a shared model
// loads strictly here, and acts on none of them. Mirrors the TS uiWebProvider.

using MetaObjects.Registry.Spec;

namespace MetaObjects.Presentation.Ui;

/// <summary>
/// Kind-1 provider (<c>metaobjects-ui-web</c>): extends <c>view.textarea</c> and
/// <c>view.image</c> with the attrs declared in <c>spec/metamodel/ui-web.json</c>.
/// </summary>
public sealed class UiWebMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry.</summary>
    public static readonly IMetaDataTypeProvider Instance = new UiWebMetaDataProvider();

    /// <summary>The provider id — matches <c>ui-web.json</c>'s <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-ui-web";

    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "Web presentation view attrs — @rows (view.textarea) and the view.image control attrs. " +
        "Cross-port vocabulary only TypeScript implements so far; C# loads and type-checks them.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // Exact subtypes only (view.textarea / view.image): no wildcard to expand.
        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal));
    }
}
