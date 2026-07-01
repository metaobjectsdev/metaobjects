using System.Collections.ObjectModel;
using MetaObjects.Source;

namespace MetaObjects.Meta;

/// <summary>
/// Abstract base for every node in the metadata tree.
/// Ported 1:1 from <c>typescript/packages/metadata/src/meta/meta-data.ts</c>.
/// </summary>
public abstract class MetaData
{
    private readonly TypeId _typeId;

    // ---------------------------------------------------------------------------
    // Identity / packaging
    // ---------------------------------------------------------------------------

    public string Name { get; }

    private string? _package;
    public string? Package => _package;

    /// <summary>
    /// Resolution-only: the file-default package (the top-level
    /// <c>metadata.root</c> <c>package</c> of the declaring file) captured at
    /// PARSE time. Lets super resolution match a node by its EFFECTIVE qualified
    /// key <c>&lt;fileDefaultPackage&gt;::&lt;name&gt;</c> even when the node carries
    /// no own <c>package</c> — and, crucially, makes that key independent of the
    /// post-MERGE parent chain (after multiple differently-packaged files merge
    /// into one accumulating root, the root carries only the FIRST file's
    /// package, so an ancestor walk would mis-key cross-package nodes). Mirrors
    /// the TS <c>fileDefaultPackage</c> field. Loader-internal; not serialized.
    /// </summary>
    private string? _fileDefaultPackage;

    /// <summary>Raw super reference string, pre-resolution.</summary>
    private string? _superRef;
    public string? SuperRef => _superRef;

    /// <summary>Post-resolution super pointer; set by SetSuperResolved() after parsing.</summary>
    private MetaData? _superData;

    private bool _isAbstract;
    public bool IsAbstract => _isAbstract;

    /// <summary>Native @isArray (boolean property, NOT in attrs).</summary>
    private bool _isArray;
    public bool IsArray => _isArray;

    /// <summary>
    /// Per-node merge flag (v0.3 <c>merge: true</c> operator).
    /// When <see langword="true"/> on a node being parsed:
    ///   - If an existing same-(type,name) child is found in the current parent → reuse it (merge into it).
    ///   - If NOT found → throw.
    /// </summary>
    private bool _isMerge;
    public bool IsMerge => _isMerge;

    // ---------------------------------------------------------------------------
    // Internal storage
    // ---------------------------------------------------------------------------

    private readonly Dictionary<string, object?> _attrs = new();
    private readonly List<MetaData> _children = new();
    private MetaData? _parent;
    private bool _frozen;

    /// <summary>Registry-supplied coarse value type — set by the registry factory at node construction.</summary>
    private DataType? _dataType;

    /// <summary>Read-only accessor for <see cref="_dataType"/>; available to subclasses.</summary>
    protected DataType? DataTypeValue => _dataType;

    /// <summary>
    /// ADR-0009 provenance. Always populated; defaults to <see cref="CodeSource.Default"/>
    /// for programmatic construction (tests, factories, in-code builders). The
    /// JSON parser overwrites via <see cref="SetSource"/> during the tree walk;
    /// future phases (overlay merge, super resolution) may overwrite with merged /
    /// resolved variants. Excluded from canonical JSON serialization — loader-derived
    /// state, not metadata.
    /// </summary>
    private ErrorSource _source = CodeSource.Default;

    /// <summary>Per-instance read cache: only populated once the node is frozen.</summary>
    private readonly Dictionary<string, object?> _cache = new();

    // ---------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------

    protected MetaData(TypeId typeId, string name)
    {
        _typeId = typeId;
        Name = name;
    }

    // ---------------------------------------------------------------------------
    // Cache helper
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Memoize a derived read. Only caches once the node is frozen — a value
    /// computed during the (mutable) load phase is never stored, so it cannot
    /// go stale. After freeze the tree is immutable, so a cached entry is valid
    /// for the node's lifetime; there is no invalidation.
    /// </summary>
    protected T Cached<T>(string key, Func<T> compute)
    {
        if (_frozen && _cache.TryGetValue(key, out object? cached))
        {
            return (T)cached!;
        }
        T value = compute();
        if (_frozen) _cache[key] = value;
        return value;
    }

    // ---------------------------------------------------------------------------
    // Convenience accessors
    // ---------------------------------------------------------------------------

    public string Type => _typeId.Type;
    public string SubType => _typeId.SubType;

    /// <summary>"package::name" if package is set, else just "name". Uses :: as separator.</summary>
    public string Fqn()
    {
        if (_package is not null)
        {
            return $"{_package}{PACKAGE_SEPARATOR}{Name}";
        }
        return Name;
    }

    /// <summary>
    /// The node's package-folded qualified key: <c>&lt;pkg&gt;::&lt;name&gt;</c> where
    /// <c>pkg</c> is this node's own package if set, else the nearest ancestor's
    /// package (the file-default package, carried on the tree root). Returns the
    /// bare name when neither is available.
    ///
    /// This is the C# equivalent of TS <c>MetaData.resolutionKey()</c> and Python
    /// <c>MetaData.resolution_key()</c>. It is the SAME form a nested field's
    /// <c>@objectRef</c> uses (e.g. <c>com::example::om::Address</c>) and the key
    /// the runtime object model binds on (<see cref="ObjectClassRegistry"/>) /
    /// nested object-refs resolve against. Distinct from <see cref="Fqn"/>, which
    /// stays bare for objects (the parser does not fold the file-default package
    /// onto an object's own <c>package</c>).
    /// </summary>
    public string ResolutionKey()
    {
        // Prefer the node's own package, then the file-default package captured
        // at PARSE time (independent of the post-merge parent chain). Only when
        // neither is present (e.g. programmatic construction) fall back to the
        // nearest-ancestor package walk.
        var pkg = _package ?? _fileDefaultPackage;
        if (string.IsNullOrEmpty(pkg))
        {
            var node = _parent;
            while (node is not null)
            {
                if (!string.IsNullOrEmpty(node._package))
                {
                    pkg = node._package;
                    break;
                }
                node = node._parent;
            }
        }
        return string.IsNullOrEmpty(pkg) ? Name : $"{pkg}{PACKAGE_SEPARATOR}{Name}";
    }

    /// <summary>
    /// Loader-internal: record the file-default package captured at parse time.
    /// See the <see cref="_fileDefaultPackage"/> field doc. Honors the frozen guard.
    /// </summary>
    public void SetFileDefaultPackage(string pkg)
    {
        AssertNotFrozen();
        _fileDefaultPackage = pkg;
    }

    // ---------------------------------------------------------------------------
    // Freeze guard
    // ---------------------------------------------------------------------------

    private void AssertNotFrozen()
    {
        if (_frozen)
        {
            throw new InvalidOperationException($"Cannot mutate frozen MetaData {Fqn()}");
        }
    }

    // ---------------------------------------------------------------------------
    // Package
    // ---------------------------------------------------------------------------

    public void SetPackage(string pkg)
    {
        AssertNotFrozen();
        _package = pkg;
    }

    // ---------------------------------------------------------------------------
    // Super
    // ---------------------------------------------------------------------------

    /// <summary>Returns the resolved super model, or null if not yet resolved.</summary>
    public MetaData? SuperData => _superData;

    /// <summary>Sets the resolved super model. Normally called by super resolution after parsing and before freezing.</summary>
    public void SetSuperResolved(MetaData model)
    {
        AssertNotFrozen();
        _superData = model;
    }

    public void SetSuper(string superRef)
    {
        AssertNotFrozen();
        _superRef = superRef;
    }

    // ---------------------------------------------------------------------------
    // IsArray
    // ---------------------------------------------------------------------------

    public void SetIsArray(bool val)
    {
        AssertNotFrozen();
        _isArray = val;
    }

    /// <summary>
    /// Effective array-ness — the RESOLVING accessor for the native <c>isArray</c>
    /// flag (ADR-0039). <c>isArray</c> is a native boolean property, NOT an attr,
    /// so it has no resolving path through <see cref="Attrs"/>/<see cref="Attr"/>;
    /// a concrete node that <c>extends</c> an abstract array node inherits its
    /// array-ness only through the super chain. Reading the bare <see cref="IsArray"/>
    /// property is OWN-ONLY and silently drops inherited array-ness — every
    /// codegen / runtime / effective-serializer read of a node's effective
    /// array-ness MUST route through this method instead.
    ///
    /// Returns the node's own <c>isArray</c> if set true, else walks the super
    /// chain (own <c>true</c> always wins; a node can only widen to array, never
    /// narrow — an abstract array base extended by a concrete node stays an array).
    /// Cycle-guarded.
    /// </summary>
    public bool ResolvedIsArray()
    {
        return Cached("resolvedIsArray", () =>
        {
            MetaData? node = this;
            var visited = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
            while (node is not null && !visited.Contains(node))
            {
                if (node._isArray) return true;
                visited.Add(node);
                node = node._superData;
            }
            return false;
        });
    }

    // ---------------------------------------------------------------------------
    // DataType
    // ---------------------------------------------------------------------------

    /// <summary>Set the registry-supplied DataType. Called by the registry factory at node construction.</summary>
    public void SetDataType(DataType dt)
    {
        AssertNotFrozen();
        _dataType = dt;
    }

    // ---------------------------------------------------------------------------
    // Source (ADR-0009 provenance)
    // ---------------------------------------------------------------------------

    /// <summary>Provenance envelope for this node. Always populated. See ADR-0009.</summary>
    public ErrorSource Source => _source;

    /// <summary>
    /// Loader-internal: assign provenance. Called by parser and merge phases as
    /// they build the tree. Honors the frozen-guard like other setters.
    /// </summary>
    public void SetSource(ErrorSource src)
    {
        AssertNotFrozen();
        _source = src;
    }

    // ---------------------------------------------------------------------------
    // IsAbstract
    // ---------------------------------------------------------------------------

    public void SetIsAbstract(bool val)
    {
        AssertNotFrozen();
        _isAbstract = val;
    }

    // ---------------------------------------------------------------------------
    // IsMerge
    // ---------------------------------------------------------------------------

    public void SetIsMerge(bool val)
    {
        AssertNotFrozen();
        _isMerge = val;
    }

    // ---------------------------------------------------------------------------
    // Attributes
    // ---------------------------------------------------------------------------

    public void SetAttr(string name, object? value)
    {
        AssertNotFrozen();
        _attrs[name] = value;
    }

    /// <summary>Own (locally declared) attr value for <paramref name="name"/>, or null — excludes inherited.</summary>
    public object? OwnAttr(string name)
    {
        return _attrs.TryGetValue(name, out object? v) ? v : null;
    }

    /// <summary>
    /// Own (locally declared) attrs — a cached map; excludes attrs inherited via extends.
    /// Do not mutate — the same reference is returned on every call after freeze.
    /// </summary>
    public IReadOnlyDictionary<string, object?> OwnAttrs()
    {
        return Cached("ownAttrs", () =>
            (IReadOnlyDictionary<string, object?>)new ReadOnlyDictionary<string, object?>(
                new Dictionary<string, object?>(_attrs)));
    }

    /// <summary>True if <paramref name="name"/> is an own (locally declared) attr — excludes inherited.</summary>
    public bool OwnHasAttr(string name)
    {
        return _attrs.ContainsKey(name);
    }

    // ---------------------------------------------------------------------------
    // Effective attr accessors — own + attrs inherited via the super chain
    // (own winning on a key conflict). Own-only access is the explicit Own* opt-in above.
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Effective attrs — own + inherited via the super chain, own winning on a key conflict; cached.
    /// Do not mutate — the same reference is returned on every call after freeze.
    /// </summary>
    public IReadOnlyDictionary<string, object?> Attrs()
    {
        return Cached("attrs", () =>
        {
            var result = EffectiveAttrs(new HashSet<MetaData>(ReferenceEqualityComparer.Instance) { this });
            return (IReadOnlyDictionary<string, object?>)new ReadOnlyDictionary<string, object?>(result);
        });
    }

    /// <summary>Effective attr value for <paramref name="name"/>, or null.</summary>
    public object? Attr(string name)
    {
        return Attrs().TryGetValue(name, out object? v) ? v : null;
    }

    /// <summary>True if <paramref name="name"/> resolves to an effective attr (own or inherited).</summary>
    public bool HasAttr(string name)
    {
        return Attrs().ContainsKey(name);
    }

    // ---------------------------------------------------------------------------
    // Children
    // ---------------------------------------------------------------------------

    public void AddChild(MetaData child)
    {
        AssertNotFrozen();
        child._parent = this;
        _children.Add(child);
    }

    /// <summary>The node this node was added to as a child, or null for the tree root.</summary>
    public MetaData? Parent => _parent;

    /// <summary>Walk up to the top of the tree this node belongs to.</summary>
    public MetaData Root()
    {
        MetaData node = this;
        while (node._parent is not null)
        {
            node = node._parent;
        }
        return node;
    }

    /// <summary>Own (locally declared) children — a cached frozen list; excludes children inherited via extends.</summary>
    public IReadOnlyList<MetaData> OwnChildren()
    {
        return Cached("ownChildren", () =>
            (IReadOnlyList<MetaData>)new ReadOnlyCollection<MetaData>(new List<MetaData>(_children)));
    }

    /// <summary>Own children whose type matches — excludes inherited.</summary>
    public IReadOnlyList<MetaData> OwnChildrenOfType(string type)
    {
        return OwnChildren().Where(c => c.Type == type).ToArray();
    }

    /// <summary>Own children matching both type and subType — excludes inherited.</summary>
    public IReadOnlyList<MetaData> OwnChildrenOfSubType(string type, string subType)
    {
        return OwnChildren().Where(c => c.Type == type && c.SubType == subType).ToArray();
    }

    /// <summary>First own child with matching name, or null — excludes inherited.</summary>
    public MetaData? OwnChildByName(string name)
    {
        return OwnChildren().FirstOrDefault(c => c.Name == name);
    }

    /// <summary>First own child matching both type and name, or null — excludes inherited.</summary>
    public MetaData? OwnChildByTypeAndName(string type, string name)
    {
        return OwnChildren().FirstOrDefault(c => c.Type == type && c.Name == name);
    }

    // ---------------------------------------------------------------------------
    // Effective child accessors — own + children inherited via the super chain
    // (own shadowing super on a (type, name) match). Own-only access is the
    // explicit Own* opt-in above.
    // ---------------------------------------------------------------------------

    /// <summary>Effective children: own + inherited via the super chain, own shadowing super. Cached, read-only.</summary>
    public IReadOnlyList<MetaData> Children()
    {
        return Cached("children", () =>
        {
            var result = EffectiveChildren(new HashSet<MetaData>(ReferenceEqualityComparer.Instance) { this });
            return (IReadOnlyList<MetaData>)new ReadOnlyCollection<MetaData>(result);
        });
    }

    /// <summary>Effective children whose type matches.</summary>
    public IReadOnlyList<MetaData> ChildrenOfType(string type)
    {
        return Children().Where(c => c.Type == type).ToArray();
    }

    /// <summary>Effective children matching both type and subType.</summary>
    public IReadOnlyList<MetaData> ChildrenOfSubType(string type, string subType)
    {
        return Children().Where(c => c.Type == type && c.SubType == subType).ToArray();
    }

    /// <summary>First effective child with matching name, or null.</summary>
    public MetaData? ChildByName(string name)
    {
        return Children().FirstOrDefault(c => c.Name == name);
    }

    /// <summary>First effective child matching both type and name, or null.</summary>
    public MetaData? ChildByTypeAndName(string type, string name)
    {
        return Children().FirstOrDefault(c => c.Type == type && c.Name == name);
    }

    // ---------------------------------------------------------------------------
    // Internal helpers for effective attr / child computation
    // ---------------------------------------------------------------------------

    private Dictionary<string, object?> EffectiveAttrs(HashSet<MetaData> visited)
    {
        if (_superData is null || visited.Contains(_superData))
        {
            return new Dictionary<string, object?>(_attrs);
        }
        visited.Add(_superData);
        // Start with the super chain's effective attrs, then override with own.
        var result = _superData.EffectiveAttrs(visited);
        foreach (var (k, v) in _attrs)
        {
            result[k] = v;
        }
        return result;
    }

    private List<MetaData> EffectiveChildren(HashSet<MetaData> visited)
    {
        if (_superData is null || visited.Contains(_superData))
        {
            return new List<MetaData>(_children);
        }
        visited.Add(_superData);

        // Start from the super's effective children (already a copy from the recursive call).
        var result = _superData.EffectiveChildren(visited);

        // Track which of our own children matched (overrode) a super child position.
        var appendQueue = new List<MetaData>();

        foreach (var ownChild in _children)
        {
            // Find the index in result that has the same (type, name).
            int idx = result.FindIndex(sc => sc.Type == ownChild.Type && sc.Name == ownChild.Name);
            if (idx != -1)
            {
                // Replace the super child with our own (in-place override).
                result[idx] = ownChild;
            }
            else
            {
                // No matching super child — will be appended at the end.
                appendQueue.Add(ownChild);
            }
        }

        // Append non-overriding own children.
        result.AddRange(appendQueue);
        return result;
    }

    // ---------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------

    public void Freeze()
    {
        if (_frozen)
        {
            return; // Idempotent
        }
        _frozen = true;
        foreach (var child in _children)
        {
            child.Freeze();
        }
    }

    public bool IsFrozen() => _frozen;
}
