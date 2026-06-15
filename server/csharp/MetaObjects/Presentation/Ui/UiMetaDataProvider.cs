// FR-033 — the metaobjects-ui concern provider.
//
// Re-homes the UI / presentation / query-surface metamodel attrs OUT of the CORE
// type classes (FieldSchema / ViewSchema / LayoutSchema) and INTO a data-driven
// concern provider that reads the embedded spec/metamodel/ui.json `extends`
// directives — matching the TS uiProvider, Java UiTypesMetaDataProvider, and Python
// ui_provider. It owns:
//   - field.*       : @filterable / @sortable / @sortableDefaultOrder (Project D filter/sort layer)
//   - view.currency : @locale
//   - layout.dataGrid: @pageSize / @defaultSortField / @defaultSortOrder / @filterable / @filter / @columns
//
// The attrs + their value-types / required-ness / allowed-values / defaults are DATA
// — read from the embedded JSON (single-sourced, never hand-copied). The composed
// registry is UNCHANGED (the manifest is provider-agnostic) — this only moves WHICH
// provider registers each attr.

using MetaObjects.Core.Field;
using MetaObjects.Registry.Spec;
using MetaObjects.Shared;

namespace MetaObjects.Presentation.Ui;

/// <summary>
/// FR-033 UI concern provider (<c>metaobjects-ui</c>): extends the core field / view /
/// layout types with the presentation + query-surface attrs declared in
/// <c>spec/metamodel/ui.json</c>. Depends on the core types being registered first.
/// </summary>
public sealed class UiMetaDataProvider : IMetaDataTypeProvider
{
    /// <summary>The shared singleton — composed into the default registry alongside the core provider.</summary>
    public static readonly IMetaDataTypeProvider Instance = new UiMetaDataProvider();

    /// <summary>The provider id — matches <c>ui.json</c>'s <c>"provider"</c> field.</summary>
    public const string ProviderId = "metaobjects-ui";

    /// <summary>
    /// FR-033 — the parsed embedded spec reader, reused across composes. The 15 JSON
    /// files are immutable assembly resources, so a single parse is sufficient.
    /// </summary>
    private static readonly Lazy<SpecMetamodelReader> Reader = new(SpecMetamodelReader.Load);

    public string Id => ProviderId;

    public string? Description =>
        "MetaObjects UI / query-surface concern attrs (filterable/sortable, view.currency @locale, layout.dataGrid) — FR-033.";

    public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

    public void RegisterTypes(TypeRegistry registry)
    {
        // The ui.json field.* wildcard expands to every concrete field subtype (the
        // shared FIELD_SUBTYPES set already includes base + enum) — mirroring the
        // db / template per-subtype loops. view.currency / layout.dataGrid resolve
        // directly. Attrs are single-sourced from the embedded JSON.
        registry.ApplyProviderExtends(
            Reader.Value,
            ProviderId,
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                [BaseTypes.TYPE_FIELD] = FieldConstants.FIELD_SUBTYPES,
            });
    }
}
