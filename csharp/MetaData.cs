namespace MetaObjects;

/// <summary>Abstract node base — the C# port of the TS MetaData typed-tree base.</summary>
public abstract class MetaData
{
    public string Type { get; }
    public string SubType { get; }
    public string Name { get; }
    public string? Package { get; set; }
    public MetaData? SuperData { get; set; }
    public bool IsAbstract { get; set; }
    public bool IsArray { get; set; }

    private readonly Dictionary<string, object?> _attrs = new();
    private readonly List<MetaData> _children = new();
    private readonly Dictionary<string, object?> _cache = new();
    private bool _frozen;

    protected MetaData(string type, string subType, string name)
    {
        Type = type;
        SubType = subType;
        Name = name;
    }

    public bool Frozen => _frozen;

    public string Fqn() => Package is null ? Name : $"{Package}::{Name}";

    public void SetAttr(string key, object? value)
    {
        if (_frozen) throw new InvalidOperationException($"Cannot mutate frozen MetaData {Fqn()}");
        _attrs[key] = value;
    }

    public object? Attr(string key) => _attrs.TryGetValue(key, out var v) ? v : null;

    public IReadOnlyDictionary<string, object?> Attrs() => _attrs;

    public void AddChild(MetaData child)
    {
        if (_frozen) throw new InvalidOperationException($"Cannot mutate frozen MetaData {Fqn()}");
        _children.Add(child);
    }

    public IReadOnlyList<MetaData> Children() => _children.ToList();

    /// <summary>Own + super-chain children; an own child overrides a super child of the same (Type, Name).</summary>
    public IReadOnlyList<MetaData> EffectiveChildren() =>
        Cached("effectiveChildren", () =>
        {
            var result = new List<MetaData>(
                SuperData?.EffectiveChildren() ?? (IReadOnlyList<MetaData>)Array.Empty<MetaData>());
            foreach (var own in _children)
            {
                var idx = result.FindIndex(c => c.Type == own.Type && c.Name == own.Name);
                if (idx >= 0) result[idx] = own;
                else result.Add(own);
            }
            return (IReadOnlyList<MetaData>)result;
        });

    public void Freeze()
    {
        if (_frozen) return;
        _frozen = true;
        foreach (var c in _children) c.Freeze();
    }

    /// <summary>Memoize a derived read. Stores only once frozen — a value computed
    /// pre-freeze is never cached, so it cannot go stale. After freeze the tree is
    /// immutable, so a cached entry is valid for the node's lifetime.</summary>
    protected T Cached<T>(string key, Func<T> compute)
    {
        if (_frozen && _cache.TryGetValue(key, out var hit)) return (T)hit!;
        var value = compute();
        if (_frozen) _cache[key] = value;
        return value;
    }
}
