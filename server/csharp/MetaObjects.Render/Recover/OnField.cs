namespace MetaObjects.Render.Recover;

/// <summary>
/// Single bespoke-coercion hook. Called per field during recovery.
/// Return <c>null</c> to fall through to default coercion; return a value to override it.
/// <para>
/// <paramref name="fieldPath"/> — dot-separated path to the field being coerced.<br/>
/// <paramref name="rawValue"/> — the raw string extracted from the document.<br/>
/// <paramref name="spec"/> — the field's descriptor from <see cref="RecoverSchema"/>.
/// </para>
/// </summary>
public delegate object? OnField(string fieldPath, string rawValue, FieldSpec spec);
