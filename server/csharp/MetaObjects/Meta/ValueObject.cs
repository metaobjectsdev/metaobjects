// ValueObject — the map-backed default backing object for `object.value`.
//
// Idiomatic C# port of Java's ValueObject / TS's ValueObject: a string-keyed
// dictionary that holds its MetaObject back-reference and supports both declared
// fields and arbitrary overflow keys. THE unbound default produced by
// MetaObject.NewInstance() when no native type is registered for the object's
// resolution key.
//
// Reflection-free: a plain Dictionary<string, object?> backing store, no
// Type.GetType / Activator / PropertyInfo. AOT-safe.

namespace MetaObjects.Meta;

/// <summary>
/// The map-backed default backing object for <c>object.value</c>. Holds declared
/// field values AND arbitrary overflow keys, plus its <see cref="MetaObject"/>
/// back-reference. Implements <see cref="IMetaObjectAware"/>.
/// </summary>
public sealed class ValueObject : IMetaObjectAware
{
    private readonly Dictionary<string, object?> _values = new(StringComparer.Ordinal);
    private MetaObject? _metaData;

    /// <summary>Construct over an optional MetaObject back-reference (set at NewInstance).</summary>
    public ValueObject(MetaObject? mo = null)
    {
        _metaData = mo;
    }

    // ---------------------------------------------------------------------------
    // IMetaObjectAware
    // ---------------------------------------------------------------------------

    /// <inheritdoc />
    public MetaObject? GetMetaData() => _metaData;

    /// <inheritdoc />
    public void SetMetaData(MetaObject mo) => _metaData = mo;

    // ---------------------------------------------------------------------------
    // Map-backed value access — declared fields AND arbitrary overflow keys.
    // ---------------------------------------------------------------------------

    /// <summary>Read a value by key. Returns <see langword="null"/> for an unset key.</summary>
    public object? Get(string name) =>
        _values.TryGetValue(name, out var v) ? v : null;

    /// <summary>Write a value by key. Any string key is accepted (overflow-friendly).</summary>
    public void Set(string name, object? value) => _values[name] = value;

    /// <summary>True if the key has been set (including to <see langword="null"/>).</summary>
    public bool Has(string name) => _values.ContainsKey(name);

    /// <summary>Remove a key. Returns true if it was present.</summary>
    public bool Remove(string name) => _values.Remove(name);

    /// <summary>Insertion-ordered keys currently held.</summary>
    public IReadOnlyList<string> Keys() => _values.Keys.ToList();

    /// <summary>A plain-dictionary snapshot of the backing map.</summary>
    public IReadOnlyDictionary<string, object?> ToDictionary() =>
        new Dictionary<string, object?>(_values, StringComparer.Ordinal);
}
