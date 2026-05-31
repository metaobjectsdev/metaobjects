// ITypedFieldAccessor — the AOT-safe typed-lane field accessor.
//
// A bound (registered) backing type implements this so the MetaField value SPI
// (GetValue / SetValue) can read/write its declared fields WITHOUT reflection
// (no PropertyInfo.GetValue / SetValue). The type itself dispatches a field name
// to its own strongly-typed property — generated code emits a trivial switch,
// keeping the typed lane reflection-free and .NET-AOT / trimming safe (ADR-0001).
//
// The map-backed ValueObject does NOT need this — it is handled directly by the
// SPI via its dictionary. Only registered native types opt in.

namespace MetaObjects.Meta;

/// <summary>
/// Reflection-free field accessor for a bound backing type. Implementors dispatch
/// a field name to their own typed members (typically a generated <c>switch</c>),
/// so <see cref="MetaField.GetValue"/> / <see cref="MetaField.SetValue"/> never
/// reach for reflection.
/// </summary>
public interface ITypedFieldAccessor
{
    /// <summary>Read the named field's value via the type's own typed member.</summary>
    object? GetFieldValue(string name);

    /// <summary>Write the named field's value via the type's own typed member.</summary>
    void SetFieldValue(string name, object? value);
}
