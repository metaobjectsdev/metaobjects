// FilterPredicate — substrate-agnostic record describing one parsed filter
// predicate (field, op, coerced value). Returned by FilterParser; consumed by
// dispatchers like EfCoreFilterDispatch that translate it to a substrate query.
//
// Part of the codegen runtime surface — consumers reference this assembly at
// runtime in their ASP.NET Core host. Mirrors Java codegen-spring's
// runtime/FilterPredicate.java.

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// A single parsed + validated filter predicate from the FR-009 URL grammar
/// (<c>filter[&lt;field&gt;][&lt;op&gt;]=&lt;value&gt;</c>).
/// </summary>
/// <param name="Field">Allowlisted field name (already validated).</param>
/// <param name="Op">Allowlisted operator (already validated against the field's subtype).</param>
/// <param name="Value">
/// The coerced value: <see langword="string"/> for scalar ops on string-shaped
/// subtypes, a <see cref="System.Collections.Generic.List{T}"/> of strings for
/// <c>in</c>, a <see langword="bool"/> for <c>isNull</c>. The dispatcher is
/// responsible for any further conversion to the column type.
/// </param>
public sealed record FilterPredicate(string Field, string Op, object? Value);
