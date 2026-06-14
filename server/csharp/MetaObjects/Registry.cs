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
/// parent node. Any field set to <see cref="MetaObjects.Shared.Structural.CHILD_RULE_WILDCARD"/>
/// ("*") matches any value.
/// <para>
/// FR-033 — the strict structural constraint graph. Cardinality
/// (<paramref name="Min"/>/<paramref name="Max"/>) is emitted only when set;
/// <paramref name="MaxIsNull"/> distinguishes a declared <c>max: null</c>
/// (unbounded) from an absent <c>max</c> (mirrors Java's <c>maxIsNull</c>).
/// <paramref name="Named"/> records whether the child must carry an explicit
/// name. All additive — existing <c>new ChildRule(t, s, n)</c> calls keep
/// working via the defaults. (<paramref name="ChildSubType"/> stays a single
/// string for now; a list-of-admitted-subtypes form arrives in S-B2a.)
/// </para>
/// </summary>
public sealed record ChildRule(
    string ChildType,
    string ChildSubType,
    string ChildName,
    int? Min = null,
    int? Max = null,
    bool MaxIsNull = false,
    bool? Named = null);

// ---------------------------------------------------------------------------
// AttrSchema
// ---------------------------------------------------------------------------

/// <summary>
/// Declares one attribute that a (type, subType) node may carry.
/// <para>
/// <paramref name="ValueType"/> must not be <see cref="MetaObjects.Shared.BaseTypes.SUBTYPE_BASE"/>
/// ("base"). Polymorphic attrs (e.g. <c>@default</c>) must omit
/// <paramref name="ValueType"/> (pass <see langword="null"/>).
/// </para>
/// <para>
/// <paramref name="IsArray"/> marks an array-valued attr (a list of the scalar
/// <paramref name="ValueType"/>) — the single orthogonal array axis that replaced
/// the retired <c>stringarray</c> subtype, mirroring Java's
/// <c>StringAttribute + @isArray</c>. The loader coerces an array-flagged attr
/// through the array string-attr coercion (bare-string → one-element array).
/// </para>
/// </summary>
public sealed record AttrSchema(
    string Name,
    string? ValueType,
    bool Required,
    object? Default = null,
    IReadOnlyList<object>? AllowedValues = null,
    string Description = "",
    bool IsArray = false,
    string? Rules = null,
    string? Example = null,
    string? WhenToUse = null);

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

    // FR-033 — the documentation surface + child-side placement claim (sourced
    // from the embedded spec/metamodel/*.json in sub-step B1). <c>Description</c>
    // is required + non-empty in the canonical; <c>Rules</c>/<c>Example</c>/
    // <c>WhenToUse</c> are optional (emitted only when present); <c>Parents</c> is
    // the child-side placement claim (emitted only when non-empty, sorted ASCII).
    // All additive with empty/null defaults so existing constructions keep working.
    public string? Rules { get; }
    public string? Example { get; }
    public string? WhenToUse { get; }
    public IReadOnlyList<string> Parents { get; }

    public TypeDefinition(
        TypeId typeId,
        string description,
        List<ChildRule> childRules,
        Func<TypeId, string, MetaData> factory,
        List<AttrSchema> attributes,
        DataType? dataType = null,
        string? rules = null,
        string? example = null,
        string? whenToUse = null,
        IReadOnlyList<string>? parents = null)
    {
        TypeId = typeId;
        Description = description;
        _childRules = new List<ChildRule>(childRules);
        Factory = factory;
        _attributes = new List<AttrSchema>(attributes);
        DataType = dataType;
        Rules = rules;
        Example = example;
        WhenToUse = whenToUse;
        Parents = parents is null ? [] : new List<string>(parents);
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
    // Sealing (ADR-0023 Decision 2)
    // ------------------------------------------------------------------

    /// <summary>
    /// ADR-0023 Decision 2 — sealed state. Once sealed, every mutating registration
    /// method throws <see cref="ErrorCode.ERR_REGISTRY_SEALED"/>. C# composes from an
    /// explicit immutable provider set (ComposeRegistry(CoreProviders)), so sealing is
    /// the guard + negative test — no polluted singleton to pivot off. The library
    /// seals after the metamodel bootstrap; a downstream app composes its own
    /// (unsealed) registry.
    /// </summary>
    private bool _sealed;

    /// <summary>Seal the registry: every subsequent mutating registration throws
    /// <see cref="ErrorCode.ERR_REGISTRY_SEALED"/>. Idempotent. Reads are unaffected.</summary>
    public void Seal() => _sealed = true;

    /// <summary>Whether this registry has been sealed (ADR-0023).</summary>
    public bool IsSealed => _sealed;

    private void CheckNotSealed(string operation)
    {
        if (_sealed)
        {
            throw new MetaModelException(
                $"TypeRegistry is sealed (ADR-0023): {operation} is not permitted after " +
                "metamodel bootstrap. Made-up metamodel attributes/types are structurally " +
                "disallowed — a new metamodel attribute requires a registered provider + " +
                "human agreement. Downstream apps that need extra vocabulary must compose " +
                "their own (unsealed) registry.",
                ErrorCode.ERR_REGISTRY_SEALED);
        }
    }

    // ------------------------------------------------------------------
    // Register
    // ------------------------------------------------------------------

    /// <summary>
    /// Register a new type definition. Throws <see cref="InvalidOperationException"/>
    /// on a duplicate (type, subType) or on an attr whose
    /// <see cref="AttrSchema.ValueType"/> is <see cref="MetaObjects.Shared.BaseTypes.SUBTYPE_BASE"/>.
    /// </summary>
    public void Register(TypeDefinition def)
    {
        CheckNotSealed($"Register(\"{def.TypeId}\")");
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
            if (attr.ValueType == SUBTYPE_BASE)
            {
                throw new InvalidOperationException(
                    $"TypeRegistry.Register: attr \"{attr.Name}\" on \"{key}\" declares " +
                    $"valueType \"{SUBTYPE_BASE}\", which is not valid for attrs. " +
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
    public void SetDefaultSubType(string type, string subType)
    {
        CheckNotSealed($"SetDefaultSubType(\"{type}\")");
        _defaultSubTypes[type] = subType;
    }

    /// <summary>The designated default subType for a type, or null if none was set.</summary>
    public string? DefaultSubTypeOf(string type) =>
        _defaultSubTypes.TryGetValue(type, out string? sub) ? sub : null;

    // ------------------------------------------------------------------
    // Common attrs
    // ------------------------------------------------------------------

    private readonly List<AttrSchema> _commonAttrs = new();

    /// <summary>
    /// Register attrs that are accepted on every metatype. Used by providers to
    /// declare cross-cutting attrs (e.g. documentation attrs). Repeated
    /// registration of the same name is silently deduped (first registration
    /// wins); conflicts with per-type attrs are detected at validation time.
    /// Throws <see cref="InvalidOperationException"/> if any attr has
    /// ValueType == SUBTYPE_BASE.
    /// </summary>
    public void RegisterCommonAttrs(IEnumerable<AttrSchema> attrs)
    {
        CheckNotSealed("RegisterCommonAttrs");
        foreach (AttrSchema attr in attrs)
        {
            if (attr.ValueType == SUBTYPE_BASE)
            {
                throw new InvalidOperationException(
                    $"TypeRegistry.RegisterCommonAttrs: attr \"{attr.Name}\" declares " +
                    $"valueType \"{SUBTYPE_BASE}\", which is not valid for attrs. " +
                    $"Use no valueType (null) for a polymorphic/untyped attr.");
            }

            if (_commonAttrs.Any(existing => existing.Name == attr.Name))
            {
                continue; // first-wins dedupe; per-type conflicts handled at validation time
            }

            _commonAttrs.Add(attr);
        }
    }

    /// <summary>Returns the registered common attrs (defensive copy).</summary>
    public IReadOnlyList<AttrSchema> GetCommonAttrs() => _commonAttrs.ToList();

    // ------------------------------------------------------------------
    // AttrsOf
    // ------------------------------------------------------------------

    /// <summary>
    /// The declared attribute schemas for (type, subType), or an empty list
    /// if the pair is unregistered or has no attributes.
    /// </summary>
    public IReadOnlyList<AttrSchema> AttrsOf(string type, string subType) =>
        Find(type, subType)?.Attributes.ToList() ?? [];

    /// <summary>
    /// Locate the schema for <paramref name="attrName"/> on (type, subType): per-type
    /// declaration wins, common attrs fill the rest. Returns null when the attr is
    /// not declared on either tier (open policy — undeclared attrs are not flagged).
    /// </summary>
    public AttrSchema? FindAttrSchema(string type, string subType, string attrName)
    {
        TypeDefinition? def = Find(type, subType);
        if (def is not null)
        {
            foreach (AttrSchema a in def.Attributes)
            {
                if (a.Name == attrName) return a;
            }
        }
        foreach (AttrSchema a in _commonAttrs)
        {
            if (a.Name == attrName) return a;
        }
        return null;
    }

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
        CheckNotSealed($"Extend(\"{type}.{subType}\")");
        TypeDefinition? def = Find(type, subType);
        if (def is null)
        {
            throw new InvalidOperationException(
                $"TypeRegistry.Extend: no registered type \"{type}.{subType}\" to extend");
        }

        foreach (AttrSchema attr in attributes ?? [])
        {
            if (attr.ValueType == SUBTYPE_BASE)
            {
                throw new InvalidOperationException(
                    $"TypeRegistry.Extend: attr \"{attr.Name}\" being added to \"{type}.{subType}\" " +
                    $"declares valueType \"{SUBTYPE_BASE}\", which is not valid for attrs. " +
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
        (rule.ChildType == CHILD_RULE_WILDCARD || rule.ChildType == childType) &&
        (rule.ChildSubType == CHILD_RULE_WILDCARD || rule.ChildSubType == childSubType) &&
        (rule.ChildName == CHILD_RULE_WILDCARD || rule.ChildName == childName);
}
