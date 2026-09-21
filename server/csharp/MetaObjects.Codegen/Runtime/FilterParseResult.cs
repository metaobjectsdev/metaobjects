// FilterParseResult — outcome of FilterParser.Parse: either a list of
// validated predicates (success) or an error envelope key (one of
// invalid_filter_field / invalid_filter_op / invalid_filter_value).
//
// Part of the codegen runtime surface; mirrors Java codegen-spring's
// runtime/FilterParseResult.java.

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Result of <see cref="FilterParser.Parse"/>. Exactly one of
/// <see cref="Predicates"/> (success path) or <see cref="ErrorEnvelope"/>
/// (failure path) is meaningful; on failure <see cref="Predicates"/> is empty.
/// </summary>
/// <param name="Predicates">The validated + coerced predicates on success; empty on failure.</param>
/// <param name="ErrorEnvelope">
/// Cross-port error envelope key (<c>invalid_filter_field</c> /
/// <c>invalid_filter_op</c> / <c>invalid_filter_value</c>) on failure;
/// <see langword="null"/> on success.
/// </param>
/// <param name="Field">
/// The offending filter field on failure; <see langword="null"/> on success.
/// REQUIRED on the wire for every contract envelope that is about a field
/// (<c>invalid_filter_field</c> / <c>invalid_filter_op</c> /
/// <c>invalid_filter_value</c>) — the caller must not have to guess which of
/// several filters was rejected.
/// </param>
public sealed record FilterParseResult(
    System.Collections.Generic.IReadOnlyList<FilterPredicate> Predicates,
    string? ErrorEnvelope,
    string? Field = null)
{
    /// <summary>Success result with the given predicates (may be empty).</summary>
    public static FilterParseResult Ok(System.Collections.Generic.IReadOnlyList<FilterPredicate> predicates) =>
        new(predicates, null);

    /// <summary>Failure result with the cross-port error envelope key + offending field.</summary>
    public static FilterParseResult Err(string envelope, string field) =>
        new(System.Array.Empty<FilterPredicate>(), envelope, field);
}
