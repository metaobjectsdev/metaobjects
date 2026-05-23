// View attribute schemas — attrs on view.currency.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/view/view-schema.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Presentation.View;

/// <summary>Attribute schemas for the view concern.</summary>
public static class ViewSchema
{
    /// <summary>Attrs on view.currency.</summary>
    public static readonly IReadOnlyList<AttrSchema> CurrencyViewAttrs =
    [
        new AttrSchema(
            Name: ViewConstants.VIEW_CURRENCY_ATTR_LOCALE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Default: ViewConstants.VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
            Description: "BCP 47 locale code controlling currency display formatting. Defaults to 'en-US' when omitted."),
    ];
}
