// View concern constants — view subtypes (UI control kinds) + currency-view attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/presentation/view/view-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Presentation.View;

/// <summary>
/// View concern constants — the view subtypes + the currency-view formatting attrs.
///
/// SP-G Phase1 Unit3 (B-2): the 11 generic web-presentation control kinds
/// (text/textarea/date/month/hotlink/dropdown/radio/checkbox/number/password/
/// hidden/web) are TS-web-presentation-only — they have NO backend / codegen /
/// render consumer in C#, so they are dead vocab here and were DEREGISTERED.
/// They remain registered in TypeScript (the web client + TS form codegen
/// require them for authoring). Only <c>base</c> + <c>currency</c> (the
/// cross-port currency <c>@locale</c> wire contract) are registered cross-port.
/// </summary>
public static class ViewConstants
{
    public const string VIEW_SUBTYPE_CURRENCY = "currency";

    public static readonly string[] VIEW_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
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
