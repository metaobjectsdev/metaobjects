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

    /// <summary>
    /// Max children of this (type, subType) per parent. 0 = unbounded (the default);
    /// 1 = singleton. Loader-enforced (ERR_TOO_MANY_OCCURRENCES). Config-driven —
    /// declared on the type, not special-cased in the loader.
    /// </summary>
    public int MaxOccurs { get; }

    /// <summary>
    /// Default name for a singleton (<see cref="MaxOccurs"/> == 1) child declared with
    /// no name. The parser names the node from this (e.g. identity.primary → "primary")
    /// and serializes it with that name. Null when none.
    /// </summary>
    public string? DefaultName { get; }

    /// <summary>
    /// Cross-references this type's attrs declare — resolved generically against the symbol
    /// table by the registry-derived validation walk. Carried by the type's registration, so
    /// a downstream provider's references validate with no core changes. Never null.
    /// </summary>
    public IReadOnlyList<MetaObjects.Validation.ReferenceDescriptor> References { get; internal set; } = [];

    /// <summary>The type's imperative validator (logic config can't express), or null.</summary>
    public MetaObjects.Validation.NodeValidator? Validate { get; internal set; }

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
        IReadOnlyList<string>? parents = null,
        int maxOccurs = 0,
        string? defaultName = null)
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
        MaxOccurs = maxOccurs;
        DefaultName = defaultName;
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

    // ------------------------------------------------------------------
    // #265 — attr provenance (which provider registered/extended each attr)
    // ------------------------------------------------------------------

    /// <summary>
    /// #265 — sentinel attr-provenance origin for an attr registered/extended with no
    /// active provider id (an unstamped registration — e.g. a hand-built registry in a
    /// unit test that never goes through <see cref="Provider.ComposeRegistry"/>'s
    /// stamping loop, or any future registration path that forgets to set
    /// <see cref="CurrentProviderId"/>). Treated as LIBRARY origin by the strict-attr-
    /// scoping prune guard (<see cref="ApplyStrictAttrScoping"/>) — i.e. still
    /// prunable, preserving pre-#265 behavior for anything not explicitly attributed
    /// to a provider.
    /// </summary>
    public const string LibrarySentinel = "__library__";

    /// <summary>
    /// #265 — the provider id active during the CURRENT <c>RegisterTypes()</c> call,
    /// set/cleared by <see cref="Provider.ComposeRegistry"/> around each provider's
    /// turn. Null outside a compose loop (e.g. a hand-built registry in a unit test).
    /// </summary>
    internal string? CurrentProviderId { get; set; }

    /// <summary>
    /// #265 — (type, subType, attrName) -> the provider id that registered/extended
    /// that attr (<see cref="LibrarySentinel"/> when unstamped). Consulted by
    /// <see cref="ApplyStrictAttrScoping"/> so a consumer-registered attr on a
    /// spec-declared subtype is never pruned by the library's strict per-subtype
    /// allow-list — only LIBRARY-origin attrs are.
    /// </summary>
    private readonly Dictionary<(string Type, string SubType, string AttrName), string> _attrProvenance = new();

    /// <summary>Stamp provenance for one (type, subType, attrName) — the provider active
    /// via <see cref="CurrentProviderId"/>, or <see cref="LibrarySentinel"/> when
    /// unstamped. Called per-attr from <see cref="Register"/> (captures a provider's own
    /// build-time enrichment too, since it reads the attrs already on the definition at
    /// registration time) and from <see cref="Extend"/>.</summary>
    private void StampAttrProvenance(string type, string subType, string attrName)
    {
        _attrProvenance[(type, subType, attrName)] = CurrentProviderId ?? LibrarySentinel;
    }

    /// <summary>The provider id that registered/extended <paramref name="attrName"/> on
    /// (<paramref name="type"/>, <paramref name="subType"/>), or <see cref="LibrarySentinel"/>
    /// if unstamped. #265 provenance-scoped strict prune.</summary>
    public string AttrOrigin(string type, string subType, string attrName) =>
        _attrProvenance.TryGetValue((type, subType, attrName), out string? origin) ? origin : LibrarySentinel;

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

        // #265 — stamp provenance for every attr present at registration time (also
        // captures a provider's own build-time enrichment, e.g. a provider building its
        // own AttrSchema list before calling Register()).
        foreach (AttrSchema attr in def.Attributes)
        {
            StampAttrProvenance(def.TypeId.Type, def.TypeId.SubType, attr.Name);
        }

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

            // ADR-0050, the second door. A common attr is projected onto EVERY registered
            // type, so a required one is the same defect as a required Extend() — with the
            // widest possible blast radius: drop the provider and every type silently loses
            // a required-attr rule. Java is immune by construction (its
            // registerCommonAttribute takes no required parameter); AttrSchema carries
            // Required, so this port needs the explicit guard.
            if (attr.Required)
            {
                throw new MetaModelException(
                    $"TypeRegistry.RegisterCommonAttrs: attribute \"{attr.Name}\" is REQUIRED. " +
                    "A common attr is projected onto every registered type, so a required one " +
                    "would vanish from all of them whenever its provider is composed out. " +
                    "Common attrs must be optional (ADR-0050).",
                    ErrorCode.ERR_EXTEND_REQUIRED_ATTR);
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
    /// already exists on the type. Throws <see cref="MetaModelException"/> with
    /// <see cref="ErrorCode.ERR_EXTEND_REQUIRED_ATTR"/> (ADR-0050) if an attr
    /// being extended is REQUIRED — a concern provider may only PROJECT optional
    /// attributes onto a type it does not own; a required attr belongs OWN, with
    /// its type, in the type's own provider. Fails closed: the offending attr is
    /// not applied.
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

            // ADR-0050: a REQUIRED attr may never be PROJECTED onto someone else's type.
            // Extend is how a concern provider decorates a type another provider owns, and
            // a concern can be composed out. A required attr arriving this way makes the
            // target type's validity depend on an optional provider — and the failure is
            // silent: drop the provider and the type stays registered while its required-attr
            // rule simply stops firing, so invalid metadata begins loading clean.
            //
            // If the attr is genuinely required, it is OWN, not projected: declare it with the
            // type, in the type's own provider. This is exactly how FR-033 broke template.*'s
            // @payloadRef / @toolName, and this guard makes that class unrepresentable rather
            // than merely fixed.
            if (attr.Required)
            {
                throw new MetaModelException(
                    $"TypeRegistry.Extend: attribute \"{attr.Name}\" being added to \"{type}.{subType}\" is REQUIRED. " +
                    $"A provider may only project OPTIONAL attributes onto a type it does not own — a required " +
                    $"attr registered this way disappears, silently, whenever that provider is composed out. " +
                    $"Declare it with the type instead (ADR-0050).",
                    ErrorCode.ERR_EXTEND_REQUIRED_ATTR);
            }

            def.AppendAttr(attr);
            // #265 — stamp the extending provider as this attr's origin.
            StampAttrProvenance(type, subType, attr.Name);
        }

        foreach (ChildRule rule in childRules ?? [])
        {
            def.AppendChildRule(rule);
        }
    }

    // ------------------------------------------------------------------
    // FR-033 (provider re-home) — apply a concern provider's extends directives
    // ------------------------------------------------------------------

    /// <summary>
    /// FR-033 — apply a concern provider's <c>extends</c> directives (read from the
    /// embedded <c>spec/metamodel/&lt;provider&gt;.json</c> by
    /// <see cref="MetaObjects.Registry.Spec.SpecMetamodelReader"/>) onto the
    /// already-registered types, re-homing the provider's attrs OUT of the core type
    /// classes and INTO the concern provider. This is the data-driven mechanism the
    /// <c>metaobjects-ui</c> / <c>metaobjects-prompt</c> providers use — the C#
    /// analogue of TS/Java/Python reading the same <c>extends</c> blocks.
    /// <para>
    /// For each directive the target subtypes are resolved: an exact subtype, a list,
    /// or the <c>"*"</c> wildcard expanded via <paramref name="fieldSubtypeExpansion"/>
    /// (when no explicit expansion is supplied for a wildcarded type, the wildcard
    /// expands to every CURRENTLY-REGISTERED subtype of that type — matching the
    /// historical per-subtype loops). Each attr is added via <see cref="Extend"/>,
    /// whose already-exists guard is the backstop ensuring an attr is registered by
    /// exactly ONE provider (no double-registration with core).
    /// </para>
    /// </summary>
    public void ApplyProviderExtends(
        MetaObjects.Registry.Spec.SpecMetamodelReader reader,
        string providerName,
        IReadOnlyDictionary<string, IReadOnlyList<string>>? fieldSubtypeExpansion = null)
    {
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(providerName);
        CheckNotSealed($"ApplyProviderExtends(\"{providerName}\")");

        foreach (MetaObjects.Registry.Spec.SpecExtendsDirective d in reader.ExtendsDirectives(providerName))
        {
            IReadOnlyList<string> targets;
            if (d.WildcardSubType)
            {
                if (fieldSubtypeExpansion is not null
                    && fieldSubtypeExpansion.TryGetValue(d.Type, out IReadOnlyList<string>? explicitExpansion))
                {
                    targets = explicitExpansion;
                }
                else
                {
                    // Fall back to every currently-registered subtype of the type.
                    targets = AllTypes()
                        .Where(id => id.Type == d.Type)
                        .Select(id => id.SubType)
                        .ToList();
                }
            }
            else
            {
                targets = d.SubTypes;
            }

            List<AttrSchema> schemas = d.Attrs.Select(ToAttrSchema).ToList();
            foreach (string subType in targets)
            {
                Extend(d.Type, subType, attributes: schemas);
            }
        }
    }

    /// <summary>FR-033 — build a fully-specified <see cref="AttrSchema"/> from a JSON extends attr entry (single-sourced, never hand-copied).</summary>
    private static AttrSchema ToAttrSchema(MetaObjects.Registry.Spec.SpecExtendsAttr a) =>
        new(
            Name: a.Name,
            ValueType: a.ValueType,
            Required: a.Required,
            Default: a.Default,
            AllowedValues: a.AllowedValues,
            IsArray: a.IsArray);

    // ------------------------------------------------------------------
    // FR-033 (sub-step B1) — apply spec/metamodel descriptions (pre-seal)
    // ------------------------------------------------------------------

    /// <summary>
    /// FR-033 (sub-step B1) — source every type / attr / common-attr DESCRIPTION
    /// (+ optional <c>rules</c>/<c>example</c>/<c>whenToUse</c>) from the shared
    /// <c>spec/metamodel/*.json</c> (read by
    /// <see cref="MetaObjects.Registry.Spec.SpecMetamodelReader"/>) onto this registry.
    /// <para>
    /// Applied DURING composition, BEFORE <see cref="Seal"/>: <see cref="TypeDefinition"/>
    /// has get-only doc props, so each definition the JSON describes is REBUILT (preserving
    /// factory / dataType / child rules / the S-A doc slots) carrying the JSON type docs
    /// + per-attr doc descriptions; <see cref="AttrSchema"/> is a record, rebuilt via
    /// <c>with</c> matched by <c>(type.subType, attrName)</c>; each common attr is rebuilt
    /// with its description from the universal <c>*.*</c> documentation entry. Descriptions
    /// come from the JSON ONLY — never hand-copied — so they are byte-identical to TS.
    /// </para>
    /// <para>
    /// Where C# registers an attr the JSON does NOT describe for that subtype (or
    /// vice-versa) the attr keeps its existing description — that scoping mismatch is the
    /// S-B2 per-subtype attr-scoping residual; B1 applies descriptions only where they match.
    /// </para>
    /// </summary>
    internal void ApplySpecDescriptions(MetaObjects.Registry.Spec.SpecMetamodelReader reader)
    {
        CheckNotSealed("ApplySpecDescriptions");

        foreach (string key in _defs.Keys.ToList())
        {
            TypeDefinition def = _defs[key];
            TypeId id = def.TypeId;

            MetaObjects.Registry.Spec.SpecDocFacet? typeDoc = reader.TypeDoc(id.Type, id.SubType);
            string description = typeDoc?.Description ?? def.Description;
            string? rules = typeDoc is not null ? typeDoc.Rules : def.Rules;
            string? example = typeDoc is not null ? typeDoc.Example : def.Example;
            string? whenToUse = typeDoc is not null ? typeDoc.WhenToUse : def.WhenToUse;

            // Rebuild each attr with its JSON doc fields (matched by (type.subType, name),
            // honouring extends blocks + the <type>.base fallback). Unmatched attrs keep
            // their existing description (the S-B2 scoping residual).
            List<AttrSchema> attrs = def.Attributes.Select(attr =>
            {
                MetaObjects.Registry.Spec.SpecAttrEntry? a = reader.AttrDoc(id.Type, id.SubType, attr.Name);
                return a is null
                    ? attr
                    : attr with
                    {
                        Description = a.Description ?? "",
                        Rules = a.Rules,
                        Example = a.Example,
                        WhenToUse = a.WhenToUse,
                    };
            }).ToList();

            _defs[key] = CopyValidation(def, new TypeDefinition(
                id,
                description,
                new List<ChildRule>(def.ChildRules),
                def.Factory,
                attrs,
                def.DataType,
                rules,
                example,
                whenToUse,
                def.Parents,
                def.MaxOccurs,
                def.DefaultName));
        }

        // Common-attr descriptions from the universal *.* documentation entry.
        for (int i = 0; i < _commonAttrs.Count; i++)
        {
            AttrSchema attr = _commonAttrs[i];
            MetaObjects.Registry.Spec.SpecAttrEntry? a = reader.CommonAttrDoc(attr.Name);
            if (a is not null)
            {
                _commonAttrs[i] = attr with
                {
                    Description = a.Description ?? "",
                    Rules = a.Rules,
                    Example = a.Example,
                    WhenToUse = a.WhenToUse,
                };
            }
        }

        // FR-033 (sub-step B2a) — replace each declared type's STRUCTURAL child
        // rules with the strict cross-port graph + cardinality from the JSON.
        ApplyStrictStructuralChildren(reader);

        // FR-033 (sub-step B2b) — prune each declared type's LOGICAL attrs to the
        // strict per-subtype allow-list from the JSON (the loader now rejects a
        // misplaced attr → ERR_UNKNOWN_ATTR).
        ApplyStrictAttrScoping(reader);
    }

    /// <summary>
    /// FR-033 (sub-step B2a) — for every registered <c>(type, subType)</c> the spec
    /// declares, REBUILD its <see cref="TypeDefinition"/> so its STRUCTURAL (non-attr)
    /// child rules are EXACTLY the strict <c>spec/metamodel/*.json</c> graph
    /// (extendsBase-composed, carrying <c>min</c>/<c>max</c>/<c>maxIsNull</c>/<c>named</c>).
    /// The attr child rules and any attr requirements are preserved verbatim; only the
    /// structural rules are swapped — C#'s broad/cardinality-less structural wildcards
    /// (e.g. <see cref="ChildRuleHelper"/> <c>Wildcard(...)</c>) are dropped. Types NOT
    /// in the JSON (e.g. <c>metadata.root</c>, <c>attr.*</c>) keep their hand-coded
    /// structural children. Mirrors the Java/Python reader's pass 4.
    /// </summary>
    /// <summary>Carry a type's validation (references + validator) across a rebuild — the
    /// constructor does not thread them, like the doc-slot/strict-scoping rebuilds.</summary>
    private static TypeDefinition CopyValidation(TypeDefinition source, TypeDefinition rebuilt)
    {
        rebuilt.References = source.References;
        rebuilt.Validate = source.Validate;
        return rebuilt;
    }

    private void ApplyStrictStructuralChildren(MetaObjects.Registry.Spec.SpecMetamodelReader reader)
    {
        foreach (string key in _defs.Keys.ToList())
        {
            TypeDefinition def = _defs[key];
            TypeId id = def.TypeId;
            if (!reader.IsDeclared(id.Type, id.SubType))
            {
                continue; // not in the spec → keep C#'s existing structural children
            }

            // Keep every attr child rule (the strict model expresses attrs via the
            // attrs block, but C# carries an attr-type wildcard the manifest already
            // drops in SortedChildren); drop the broad structural wildcards.
            var rules = new List<ChildRule>();
            foreach (ChildRule rule in def.ChildRules)
            {
                if (rule.ChildType == TYPE_ATTR)
                {
                    rules.Add(rule); // attr placement — preserved (manifest drops it anyway)
                }
            }
            foreach (MetaObjects.Registry.Spec.SpecStructChild sc in reader.StructuralChildren(id.Type, id.SubType))
            {
                rules.Add(new ChildRule(
                    sc.ChildType, sc.ChildSubType, sc.ChildName,
                    sc.Min, sc.Max, sc.MaxIsNull, sc.Named));
            }

            _defs[key] = CopyValidation(def, new TypeDefinition(
                id, def.Description, rules, def.Factory, def.Attributes.ToList(),
                def.DataType, def.Rules, def.Example, def.WhenToUse, def.Parents,
                def.MaxOccurs, def.DefaultName));
        }
    }

    /// <summary>
    /// FR-033 (sub-step B2b) — for every registered <c>(type, subType)</c> the spec
    /// declares, DROP every LOGICAL (INCLUDED) attr whose name is NOT in the strict
    /// per-subtype allow-list (<see cref="MetaObjects.Registry.Spec.SpecMetamodelReader.StrictAttrNames"/>).
    /// The carved-out attrs (the <see cref="RegistryManifest.ClassifyPerTypeAttr"/>
    /// exclusions — structural keywords / native bindings / the per-type
    /// <c>description</c> dup) are LEFT REGISTERED: the emitter drops them from the
    /// manifest anyway and the loader needs them. Only the INCLUDED logical attrs are
    /// pruned, which TIGHTENS the loader — a misplaced attr → its unknown-attr error.
    /// Types NOT in the JSON keep their attrs untouched. Mirrors Java/Python's pass 5.
    /// <para>
    /// #265 — the prune is PROVENANCE-scoped: only a LIBRARY-origin logical attr
    /// (registered by one of the library's own providers, or unstamped — see
    /// <see cref="AttrOrigin"/> / <see cref="LibrarySentinel"/>) is prunable against
    /// the strict per-subtype allow-list. An attr a CONSUMER provider added via
    /// <see cref="Extend"/> (e.g. a downstream app widening a spec-declared core
    /// subtype) is never pruned — the strict allow-list is a library-vocabulary
    /// contract, blind to consumer-registered vocabulary by design. This does not
    /// relax the check itself (still own-attrs-only, ADR-0039) and does not widen
    /// scoping for a misplaced LIBRARY attr just because a consumer provider happens
    /// to be composed in.
    /// </para>
    /// </summary>
    private void ApplyStrictAttrScoping(MetaObjects.Registry.Spec.SpecMetamodelReader reader)
    {
        foreach (string key in _defs.Keys.ToList())
        {
            TypeDefinition def = _defs[key];
            TypeId id = def.TypeId;
            if (!reader.IsDeclared(id.Type, id.SubType))
            {
                continue; // not in the spec → keep C#'s existing attr scoping
            }

            ISet<string> allow = reader.StrictAttrNames(id.Type, id.SubType);

            var attrs = new List<AttrSchema>();
            foreach (AttrSchema attr in def.Attributes)
            {
                bool prunable =
                    RegistryManifest.ClassifyPerTypeAttr(attr.Name) == RegistryManifest.ExclusionReason.Included
                    && !allow.Contains(attr.Name);
                if (prunable)
                {
                    string origin = AttrOrigin(id.Type, id.SubType, attr.Name);
                    bool isLibraryOrigin =
                        origin == LibrarySentinel || CoreTypes.LibraryProviderIds.Contains(origin);
                    if (isLibraryOrigin)
                    {
                        continue; // library-origin logical attr not scoped to this subtype → prune
                    }
                }
                attrs.Add(attr);
            }

            _defs[key] = CopyValidation(def, new TypeDefinition(
                id, def.Description, def.ChildRules.ToList(), def.Factory, attrs,
                def.DataType, def.Rules, def.Example, def.WhenToUse, def.Parents,
                def.MaxOccurs, def.DefaultName));
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
