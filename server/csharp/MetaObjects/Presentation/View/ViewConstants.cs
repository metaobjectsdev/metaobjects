// View concern constants — view subtypes (UI control kinds) + currency-view attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/view/view-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Presentation.View;

/// <summary>
/// View concern constants — the view subtypes (the view's subType IS the UI
/// control type; mirrors metaobjects-dynamic/web html *View.java naming) and the
/// currency-view formatting attrs.
/// </summary>
public static class ViewConstants
{
    public const string VIEW_SUBTYPE_TEXT     = "text";
    public const string VIEW_SUBTYPE_TEXTAREA = "textarea";
    public const string VIEW_SUBTYPE_DATE     = "date";
    public const string VIEW_SUBTYPE_MONTH    = "month";
    public const string VIEW_SUBTYPE_HOTLINK  = "hotlink";
    public const string VIEW_SUBTYPE_DROPDOWN = "dropdown";
    public const string VIEW_SUBTYPE_RADIO    = "radio";
    public const string VIEW_SUBTYPE_CHECKBOX = "checkbox";
    public const string VIEW_SUBTYPE_NUMBER   = "number";
    public const string VIEW_SUBTYPE_PASSWORD = "password";
    public const string VIEW_SUBTYPE_HIDDEN   = "hidden";
    /// <summary>Abstract base for web-rendered views.</summary>
    public const string VIEW_SUBTYPE_WEB      = "web";
    public const string VIEW_SUBTYPE_CURRENCY = "currency";

    public static readonly string[] VIEW_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        VIEW_SUBTYPE_TEXT,
        VIEW_SUBTYPE_TEXTAREA,
        VIEW_SUBTYPE_DATE,
        VIEW_SUBTYPE_MONTH,
        VIEW_SUBTYPE_HOTLINK,
        VIEW_SUBTYPE_DROPDOWN,
        VIEW_SUBTYPE_RADIO,
        VIEW_SUBTYPE_CHECKBOX,
        VIEW_SUBTYPE_NUMBER,
        VIEW_SUBTYPE_PASSWORD,
        VIEW_SUBTYPE_HIDDEN,
        VIEW_SUBTYPE_WEB,
        VIEW_SUBTYPE_CURRENCY,
    ];

    // -----------------------------------------------------------------------
    // View attrs (on currency views)
    // -----------------------------------------------------------------------

    /// <summary>BCP 47 locale code on a view[currency]. Defaults to "en-US" when omitted.</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE         = "locale";
    /// <summary>Default BCP 47 locale code when @locale is omitted on a view[currency].</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE_DEFAULT = "en-US";
}
