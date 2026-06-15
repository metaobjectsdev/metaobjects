// FR-033 — the full core provider bundle for unit tests.
//
// After the ui/prompt re-home, the field-teaching / extract / template / view /
// layout attrs no longer live in CoreTypesProvider — they are registered by the
// dedicated metaobjects-ui / metaobjects-prompt concern providers. Unit tests that
// assert those attrs are registered (or load metadata that uses them) must compose
// the full bundle, not core-types alone. This mirrors the Python unit-test update
// (compose the full core_providers list) and the conformance DEFAULT_PROVIDERS set.

using MetaObjects.Core.Documentation;

namespace MetaObjects.Conformance.Tests;

/// <summary>Shared full-core-bundle composition for unit tests (FR-033).</summary>
internal static class FullCoreRegistry
{
    /// <summary>
    /// The full core provider bundle: core types + the DB / documentation / UI /
    /// prompt concern providers — the same composition the loader's default registry
    /// and the conformance default provider set use.
    /// </summary>
    internal static readonly IReadOnlyList<IMetaDataTypeProvider> Providers = new[]
    {
        CoreTypes.CoreTypesProvider,
        MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
        DocumentationTypes.DocTypesProvider,
        MetaObjects.Presentation.Ui.UiMetaDataProvider.Instance,
        MetaObjects.Template.PromptMetaDataProvider.Instance,
    };

    /// <summary>Compose a fresh registry from the full core bundle.</summary>
    internal static TypeRegistry Compose() => Provider.ComposeRegistry(Providers);
}
