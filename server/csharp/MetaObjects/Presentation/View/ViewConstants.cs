// View concern constants — view subtypes (UI control kinds) + currency-view attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/view/view-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Presentation.View;

/// <summary>
/// View concern constants — the view subtypes + the currency-view formatting attrs.
///
/// Every port REGISTERS the full view vocabulary, so one metadata document
/// loads in every port. The generic web-presentation control kinds (text/
/// textarea/date/month/hotlink/dropdown/radio/checkbox/number/password/hidden/
/// web/image) are still TS-web-PRESENTATION-ONLY: they have no backend / codegen /
/// render consumer in C#, and the registry manifest excludes them
/// (<c>RegistryManifest</c>, PRESENTATION_ONLY). Registration here is for LOADING
/// only. <c>base</c> + <c>currency</c> (the cross-port currency <c>@locale</c>
/// wire contract) are the two rows in the cross-port manifest.
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
    public const string VIEW_SUBTYPE_WEB      = "web";
    public const string VIEW_SUBTYPE_CURRENCY = "currency";
    public const string VIEW_SUBTYPE_IMAGE    = "image";

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
        VIEW_SUBTYPE_IMAGE,
    ];

    // -----------------------------------------------------------------------
    // View attrs (on currency views)
    // -----------------------------------------------------------------------

    /// <summary>BCP 47 locale code on a view[currency]. Defaults to "en-US" when omitted.</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE         = "locale";
    /// <summary>Default BCP 47 locale code when @locale is omitted on a view[currency].</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE_DEFAULT = "en-US";
}
