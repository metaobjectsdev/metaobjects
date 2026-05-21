using MetaObjects.Meta;

namespace MetaObjects;

// ---------------------------------------------------------------------------
// TypeId
// ---------------------------------------------------------------------------

/// <summary>
/// The (type, subType) identity of a registered metamodel type.
/// Record equality replaces the TS <c>equals()</c> method.
/// </summary>
public sealed record TypeId(string Type, string SubType)
{
    public override string ToString() => $"{Type}.{SubType}";
}

// ---------------------------------------------------------------------------
// ChildRule
// ---------------------------------------------------------------------------

/// <summary>
/// Declares which child (type, subType, name) combinations are legal under a
/// parent node. Any field set to <see cref="Constants.CHILD_RULE_WILDCARD"/>
/// ("*") matches any value.
/// </summary>
public sealed record ChildRule(string ChildType, string ChildSubType, string ChildName);

// ---------------------------------------------------------------------------
// AttrSchema
// ---------------------------------------------------------------------------

/// <summary>
/// Declares one attribute that a (type, subType) node may carry.
/// <para>
/// <paramref name="ValueType"/> must not be <see cref="Constants.SUBTYPE_BASE"/>
/// ("base"). Polymorphic attrs (e.g. <c>@default</c>) must omit
/// <paramref name="ValueType"/> (pass <see langword="null"/>).
/// </para>
/// </summary>
public sealed record AttrSchema(
    string Name,
    string? ValueType,
    bool Required,
    object? Default = null,
    IReadOnlyList<object>? AllowedValues = null,
    string Description = "");

// ---------------------------------------------------------------------------
// TypeDefinition
// ---------------------------------------------------------------------------

/// <summary>
/// All registration metadata for a single (type, subType) pair.
/// Mutable via <see cref="TypeRegistry.Extend"/> — child rules and attributes
/// can be appended after initial registration.
/// </summary>
public sealed class TypeDefinition
{
    private readonly List<ChildRule> _childRules;
    private readonly List<AttrSchema> _attributes;

    public TypeId TypeId { get; }
    public string Description { get; }
    public Func<TypeId, string, MetaData> Factory { get; }
    public IReadOnlyList<ChildRule> ChildRules => _childRules;
    public IReadOnlyList<AttrSchema> Attributes => _attributes;
    public DataType? DataType { get; }

    public TypeDefinition(
        TypeId typeId,
        string description,
        List<ChildRule> childRules,
        Func<TypeId, string, MetaData> factory,
        List<AttrSchema> attributes,
        DataType? dataType = null)
    {
        TypeId = typeId;
        Description = description;
        _childRules = new List<ChildRule>(childRules);
        Factory = factory;
        _attributes = new List<AttrSchema>(attributes);
        DataType = dataType;
    }

    internal void AppendAttr(AttrSchema attr) => _attributes.Add(attr);
    internal void AppendChildRule(ChildRule rule) => _childRules.Add(rule);
}

// ---------------------------------------------------------------------------
// TypeRegistry
// ---------------------------------------------------------------------------

/// <summary>
/// Registry of all metamodel type definitions, keyed by (type, subType).
/// Ported from <c>typescript/packages/metadata/src/registry.ts</c>.
/// </summary>
public sealed class TypeRegistry
{
    /// <summary>Keyed by "type.subType".</summary>
    private readonly Dictionary<string, TypeDefinition> _defs = new();

    /// <summary>Per-type insertion-ordered subtype lists.</summary>
    private readonly Dictionary<string, List<string>> _subTypes = new();

    /// <summary>Per-type designated default subType (used by authoring sugar).</summary>
    private readonly Dictionary<string, string> _defaultSubTypes = new();

    // ------------------------------------------------------------------
    // Register
    // ------------------------------------------------------------------

    /// <summary>
    /// Register a new type definition. Throws <see cref="InvalidOperationException"/>
    /// on a duplicate (type, subType) or on an attr whose
    /// <see cref="AttrSchema.ValueType"/> is <see cref="Constants.SUBTYPE_BASE"/>.
    /// </summary>
    public void Register(TypeDefinition def)
    {
        string key = def.TypeId.ToString();

        if (_defs.ContainsKey(key))
        {
            throw new InvalidOperationException(
                $"TypeRegistry: duplicate registration for \"{key}\" " +
                $"(type=\"{def.TypeId.Type}\", subType=\"{def.TypeId.SubType}\")");
        }

        // Reject SUBTYPE_BASE as an attr valueType — see TS comment for rationale.
        foreach (AttrSchema attr in def.Attributes)
        {
            if (attr.ValueType == Constants.SUBTYPE_BASE)
            {
                throw new InvalidOperationException(
                    $"TypeRegistry.Register: attr \"{attr.Name}\" on \"{key}\" declares " +
                    $"valueType \"{Constants.SUBTYPE_BASE}\", which is not valid for attrs. " +
                    $"Use no valueType (null) for a polymorphic/untyped attr.");
            }
        }

        _defs[key] = def;

        if (_subTypes.TryGetValue(def.TypeId.Type, out List<string>? list))
        {
            list.Add(def.TypeId.SubType);
        }
        else
        {
            _subTypes[def.TypeId.Type] = [def.TypeId.SubType];
        }
    }

    // ------------------------------------------------------------------
    // Query
    // ------------------------------------------------------------------

    /// <summary>Returns the <see cref="TypeDefinition"/> for (type, subType), or null.</summary>
    public TypeDefinition? Find(string type, string subType) =>
        _defs.TryGetValue($"{type}.{subType}", out TypeDefinition? def) ? def : null;

    /// <summary>Returns true if (type, subType) is registered.</summary>
    public bool Has(string type, string subType) => Find(type, subType) is not null;

    /// <summary>All registered type IDs.</summary>
    public IReadOnlyList<TypeId> AllTypes() =>
        _defs.Values.Select(d => d.TypeId).ToList();

    /// <summary>All registered subTypes for the given type, in insertion order.</summary>
    public IReadOnlyList<string> AllSubTypesOf(string type) =>
        _subTypes.TryGetValue(type, out List<string>? list)
            ? list.ToList()
            : [];

    // ------------------------------------------------------------------
    // Default subType
    // ------------------------------------------------------------------

    /// <summary>Designate the default subType for a bare type key (authoring sugar).</summary>
    public void SetDefaultSubType(string type, string subType) =>
        _defaultSubTypes[type] = subType;

    /// <summary>The designated default subType for a type, or null if none was set.</summary>
    public string? DefaultSubTypeOf(string type) =>
        _defaultSubTypes.TryGetValue(type, out string? sub) ? sub : null;

    // ------------------------------------------------------------------
    // AttrsOf
    // ------------------------------------------------------------------

    /// <summary>
    /// The declared attribute schemas for (type, subType), or an empty list
    /// if the pair is unregistered or has no attributes.
    /// </summary>
    public IReadOnlyList<AttrSchema> AttrsOf(string type, string subType) =>
        Find(type, subType)?.Attributes.ToList() ?? [];

    // ------------------------------------------------------------------
    // Extend
    // ------------------------------------------------------------------

    /// <summary>
    /// Additively enrich an already-registered (type, subType): append attributes
    /// and/or child rules. Does NOT touch Factory / TypeId / DataType / default
    /// subType — a type's identity belongs to whoever registered it.
    /// Throws <see cref="InvalidOperationException"/> if the (type, subType) is
    /// not registered, or if an attr's ValueType is SUBTYPE_BASE.
    /// Throws <see cref="MetaModelException"/> with
    /// <see cref="ErrorCode.ERR_PROVIDER_ATTR_CONFLICT"/> if an attr name
    /// already exists on the type.
    /// </summary>
    public void Extend(string type, string subType, IReadOnlyList<AttrSchema>? attributes = null, IReadOnlyList<ChildRule>? childRules = null)
    {
        TypeDefinition? def = Find(type, subType);
        if (def is null)
        {
            throw new InvalidOperationException(
                $"TypeRegistry.Extend: no registered type \"{type}.{subType}\" to extend");
        }

        foreach (AttrSchema attr in attributes ?? [])
        {
            if (attr.ValueType == Constants.SUBTYPE_BASE)
            {
                throw new InvalidOperationException(
                    $"TypeRegistry.Extend: attr \"{attr.Name}\" being added to \"{type}.{subType}\" " +
                    $"declares valueType \"{Constants.SUBTYPE_BASE}\", which is not valid for attrs. " +
                    $"Use no valueType (null) for a polymorphic/untyped attr.");
            }

            if (def.Attributes.Any(a => a.Name == attr.Name))
            {
                throw new MetaModelException(
                    $"TypeRegistry.Extend: attribute \"{attr.Name}\" is already declared on \"{type}.{subType}\"",
                    ErrorCode.ERR_PROVIDER_ATTR_CONFLICT);
            }

            def.AppendAttr(attr);
        }

        foreach (ChildRule rule in childRules ?? [])
        {
            def.AppendChildRule(rule);
        }
    }
}

// ---------------------------------------------------------------------------
// ChildRuleMatches
// ---------------------------------------------------------------------------

/// <summary>
/// Utility: returns true when <paramref name="rule"/> matches the given child
/// (type, subType, name). A wildcard ("*") in any rule slot matches any value.
/// Ported from the standalone <c>childRuleMatches</c> function in registry.ts.
/// </summary>
public static class ChildRuleHelper
{
    public static bool ChildRuleMatches(
        ChildRule rule,
        string childType,
        string childSubType,
        string childName) =>
        (rule.ChildType == Constants.CHILD_RULE_WILDCARD || rule.ChildType == childType) &&
        (rule.ChildSubType == Constants.CHILD_RULE_WILDCARD || rule.ChildSubType == childSubType) &&
        (rule.ChildName == Constants.CHILD_RULE_WILDCARD || rule.ChildName == childName);
}
