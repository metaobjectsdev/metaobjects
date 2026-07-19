// FR-033 — the C# reader for the shared spec/metamodel/*.json provider files.
//
// The 16 JSON files (one per concern provider) are the cross-port single source of
// truth for every type / attr / common-attr DESCRIPTION (+ optional rules/example/
// whenToUse). They are byte-identical across the ports by design, so each port READS
// them rather than hand-copying the prose — the exact duplication FR-033 kills.
//
// This reader parses the embedded JSON (bundled into the assembly as EmbeddedResource;
// AOT-safe — read via Assembly.GetManifestResourceStream, never an arbitrary filesystem
// scan) into an in-memory model and exposes, per (type, subType): the type DocFacet
// (description + rules/example/whenToUse) and, per attr (by name), the attr DocFacet
// (+ array flag / cardinality). The universal *.* entry's attr children are the
// documentation common attrs.
//
// Resolution honours the `extends` blocks (db/ui/prompt JSON). An attr declared in a
// top-level `extends` directive (e.g. db.json's @column on field.*, or @autoSet on
// field: [date, time, timestamp]) applies additively to the matching subtypes.
// AttrDoc resolves a requested (type, subType, attrName) by checking, in order: the
// exact types[].children entry, the matching `extends` block (exact subType / "*"
// wildcard / list membership), then the <type>.base fallback (the JSON's extendsBase
// inheritance). Mirrors the Java/Python SpecMetamodelReader.
//
// The reader does NOT enforce or build the strict children graph / cardinality /
// per-subtype scoping — that is sub-step B2. The model it parses (incl. structural
// children + cardinality) is the durable foundation B2 extends; B1 uses only the
// description-resolution surface.

using System.Reflection;
using System.Text.Json;

namespace MetaObjects.Registry.Spec;

/// <summary>
/// One documented metamodel facet (a type/subType) — its description plus the optional
/// doc fields. Any may be <see langword="null"/> when absent in the JSON.
/// </summary>
public sealed record SpecDocFacet(
    string? Description,
    string? Rules,
    string? Example,
    string? WhenToUse);

/// <summary>
/// An attr child entry parsed from the JSON — the description-bearing facet B1 uses,
/// plus the structural cardinality fields B2 will consume.
/// </summary>
public sealed record SpecAttrEntry(
    string Name,
    string? SubType,
    bool IsArray,
    int? Min,
    int? Max,
    bool MaxIsNull,
    string? Description,
    string? Rules,
    string? Example,
    string? WhenToUse,
    IReadOnlyList<string>? AllowedValues,
    object? Default)
{
    /// <summary>Whether this attr is required — the JSON encodes requiredness as <c>min: 1</c>.</summary>
    public bool Required => Min == 1;
}

/// <summary>
/// FR-033 (sub-step B2a) — one STRUCTURAL child entry parsed from a type's
/// <c>children</c> list (every <c>type != "attr"</c> entry), carrying the strict
/// cross-port cardinality. <c>ChildSubType</c>/<c>ChildName</c> default to <c>"*"</c>
/// when omitted; <c>MaxIsNull</c> distinguishes a declared <c>max: null</c> (unbounded)
/// from an absent <c>max</c>; <c>Named</c> is the optional named-placement flag.
/// </summary>
public sealed record SpecStructChild(
    string ChildType,
    string ChildSubType,
    string ChildName,
    int? Min,
    int? Max,
    bool MaxIsNull,
    bool? Named);

/// <summary>
/// FR-033 (provider re-home) — one re-homed attr declared in a provider's
/// <c>extends</c> directive, with the cross-port value-type / array-ness /
/// required-ness needed to build a fully-specified <c>AttrSchema</c> and register
/// it on the matching subtype. Allowed-values + default carry through so the attr
/// is single-sourced from the JSON, never hand-copied. Mirrors the Java
/// <c>ExtendsAttr</c> / Python <c>AttrEntry</c>.
/// </summary>
public sealed record SpecExtendsAttr(
    string Name,
    string? ValueType,
    bool IsArray,
    bool Required,
    IReadOnlyList<object>? AllowedValues,
    object? Default);

/// <summary>
/// FR-033 (provider re-home) — one <c>extends</c> directive from a named concern
/// provider's spec file (e.g. <c>ui.json</c>'s <c>field.*</c> or <c>prompt.json</c>'s
/// <c>template.prompt</c>). <c>WildcardSubType</c> is true for the <c>"*"</c>
/// any-subtype matcher; otherwise <c>SubTypes</c> lists the exact subtypes. Mirrors
/// the Java <c>ExtendsDirective</c> / Python <c>ExtendsTarget</c>.
/// </summary>
public sealed record SpecExtendsDirective(
    string Type,
    IReadOnlyList<string> SubTypes,
    bool WildcardSubType,
    IReadOnlyList<SpecExtendsAttr> Attrs);

/// <summary>
/// FR-033 — the C# reader over the embedded <c>spec/metamodel/*.json</c> provider files.
/// </summary>
public sealed class SpecMetamodelReader
{
    /// <summary>The 17 shared provider-definition file names (keep in lockstep with <c>spec/metamodel/</c>).</summary>
    public static readonly IReadOnlyList<string> SpecFiles = new[]
    {
        "attr.json", "db.json", "documentation.json", "field.json", "identity.json",
        "index.json", "layout.json", "object.json", "origin.json", "prompt.json",
        "relationship.json", "source.json", "template.json", "ui.json", "ui-web.json",
        "validator.json", "view.json",
    };

    /// <summary>The embedded-resource logical-name prefix (RootNamespace + folder).</summary>
    public const string ResourcePrefix = "MetaObjects.SpecMetamodel.";

    /// <summary>Wildcard token used in the JSON for "any type / any subType".</summary>
    private const string Wildcard = "*";

    /// <summary>The abstract base subtype name (the <c>extendsBase</c> inheritance root per type).</summary>
    private const string BaseSubType = "base";

    /// <summary>The attr child-type token in the JSON.</summary>
    private const string AttrChildType = "attr";

    // (type.subType) -> the type's own DocFacet
    private readonly Dictionary<string, SpecDocFacet> _typeDocs = new(StringComparer.Ordinal);
    // (type.subType) -> attrName -> SpecAttrEntry (from the types[].children attr entries)
    private readonly Dictionary<string, Dictionary<string, SpecAttrEntry>> _typeAttrDocs = new(StringComparer.Ordinal);
    // (type.subType) -> the type's OWN structural children (pre-extendsBase composition)
    private readonly Dictionary<string, List<SpecStructChild>> _typeStructChildren = new(StringComparer.Ordinal);
    // (type.subType) -> true when the subtype additively inherits <type>.base's children
    private readonly Dictionary<string, bool> _typeExtendsBase = new(StringComparer.Ordinal);
    // every (type.subType) key that appeared in a spec file
    private readonly HashSet<string> _declaredKeys = new(StringComparer.Ordinal);
    // extends directives: matcher + its attr entries (applied additively)
    private readonly List<ExtendsBlock> _extendsBlocks = new();
    // the universal *.* common-attr entries (the documentation vocabulary), by name
    private readonly Dictionary<string, SpecAttrEntry> _commonAttrDocs = new(StringComparer.Ordinal);

    private sealed record ExtendsBlock(
        string Type,
        IReadOnlyList<string> SubTypes,
        bool WildcardSubType,
        IReadOnlyDictionary<string, SpecAttrEntry> Attrs);

    // FR-033 (provider re-home) — per-provider extends directives, keyed by the
    // spec file's "provider" name (e.g. "metaobjects-ui" / "metaobjects-prompt").
    // A DATA-DRIVEN concern provider reads its own directives to register the
    // re-homed attrs onto the core types — single-sourced from the JSON, never
    // hand-copied. Mirrors the Java SpecMetamodelReader.extendsDirectives /
    // Python load_provider_extends.
    private readonly Dictionary<string, List<SpecExtendsDirective>> _providerExtends =
        new(StringComparer.Ordinal);

    private SpecMetamodelReader() { }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    /// <summary>
    /// Load + parse the 16 embedded <c>spec/metamodel/*.json</c> files off this
    /// assembly's manifest resources (AOT-safe).
    /// </summary>
    /// <exception cref="InvalidOperationException">If a spec file is missing or unparseable.</exception>
    public static SpecMetamodelReader Load()
    {
        var reader = new SpecMetamodelReader();
        Assembly asm = typeof(SpecMetamodelReader).Assembly;
        foreach (string name in SpecFiles)
        {
            string resource = ResourcePrefix + name;
            using Stream? stream = asm.GetManifestResourceStream(resource);
            if (stream is null)
            {
                throw new InvalidOperationException(
                    $"FR-033: embedded spec/metamodel file missing from the assembly: {resource} " +
                    "(it must be committed under MetaObjects/SpecMetamodel/ and marked <EmbeddedResource>).");
            }
            using var sr = new StreamReader(stream);
            string json = sr.ReadToEnd();
            try
            {
                using JsonDocument doc = JsonDocument.Parse(json);
                reader.Parse(doc.RootElement);
            }
            catch (JsonException e)
            {
                throw new InvalidOperationException(
                    $"FR-033: failed parsing embedded spec file {resource}: {e.Message}", e);
            }
        }
        return reader;
    }

    private void Parse(JsonElement provider)
    {
        // FR-033 — the spec file's "provider" name keys its extends directives so a
        // concern provider can read its own (and only its own) re-homed attrs.
        string? providerName = Str(provider, "provider");
        if (provider.TryGetProperty("types", out JsonElement types) && types.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement t in types.EnumerateArray())
            {
                string? type = Str(t, "type");
                string? subType = Str(t, "subType");
                if (type == Wildcard && subType == Wildcard)
                {
                    // The universal *.* entry: its attr children are the common attrs.
                    foreach (SpecAttrEntry a in ParseAttrChildren(t))
                    {
                        _commonAttrDocs[a.Name] = a;
                    }
                    continue;
                }
                if (type is null || subType is null)
                {
                    continue;
                }
                string key = Key(type, subType);
                _declaredKeys.Add(key);
                _typeDocs[key] = new SpecDocFacet(
                    Str(t, "description"), Str(t, "rules"), Str(t, "example"), Str(t, "whenToUse"));
                var attrs = new Dictionary<string, SpecAttrEntry>(StringComparer.Ordinal);
                foreach (SpecAttrEntry a in ParseAttrChildren(t))
                {
                    attrs[a.Name] = a;
                }
                _typeAttrDocs[key] = attrs;
                _typeStructChildren[key] = ParseStructChildren(t);
                _typeExtendsBase[key] = Bool(t, "extendsBase");
            }
        }

        if (provider.TryGetProperty("extends", out JsonElement extendsArr) && extendsArr.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement e in extendsArr.EnumerateArray())
            {
                string? type = Str(e, "type");
                if (type is null)
                {
                    continue;
                }
                var subTypes = new List<string>();
                bool wildcard = false;
                if (e.TryGetProperty("subType", out JsonElement subEl))
                {
                    if (subEl.ValueKind == JsonValueKind.Array)
                    {
                        foreach (JsonElement s in subEl.EnumerateArray())
                        {
                            subTypes.Add(s.GetString()!);
                        }
                    }
                    else if (subEl.ValueKind == JsonValueKind.String)
                    {
                        string s = subEl.GetString()!;
                        if (s == Wildcard)
                        {
                            wildcard = true;
                        }
                        else
                        {
                            subTypes.Add(s);
                        }
                    }
                }
                var attrs = new Dictionary<string, SpecAttrEntry>(StringComparer.Ordinal);
                var directiveAttrs = new List<SpecExtendsAttr>();
                foreach (SpecAttrEntry a in ParseAttrChildren(e))
                {
                    attrs[a.Name] = a;
                    // The JSON `subType` of an attr child is its value-type (string /
                    // boolean / int / properties / filter); `min == 1` ⇒ required.
                    directiveAttrs.Add(new SpecExtendsAttr(
                        Name: a.Name,
                        ValueType: a.SubType,
                        IsArray: a.IsArray,
                        Required: a.Required,
                        AllowedValues: a.AllowedValues,
                        Default: a.Default));
                }
                _extendsBlocks.Add(new ExtendsBlock(type, subTypes, wildcard, attrs));
                if (providerName is not null)
                {
                    if (!_providerExtends.TryGetValue(providerName, out List<SpecExtendsDirective>? list))
                    {
                        list = new List<SpecExtendsDirective>();
                        _providerExtends[providerName] = list;
                    }
                    list.Add(new SpecExtendsDirective(type, subTypes, wildcard, directiveAttrs));
                }
            }
        }
    }

    /// <summary>
    /// FR-033 (provider re-home) — the <c>extends</c> directives declared by the named
    /// concern provider (e.g. <c>"metaobjects-ui"</c> / <c>"metaobjects-prompt"</c>).
    /// Each directive carries its target <c>(type, subTypes/"*")</c> and the re-homed
    /// attrs with their cross-port value-type / array-ness / required-ness / allowed
    /// values / default — the data a concern provider uses to register those attrs on
    /// the matching subtypes via <see cref="TypeRegistry.Extend"/>. Empty when the
    /// provider declares no <c>extends</c> block. Mirrors the Java
    /// <c>extendsDirectives</c> / Python <c>load_provider_extends</c>.
    /// </summary>
    public IReadOnlyList<SpecExtendsDirective> ExtendsDirectives(string providerName) =>
        _providerExtends.TryGetValue(providerName, out List<SpecExtendsDirective>? list)
            ? list
            : Array.Empty<SpecExtendsDirective>();

    private static List<SpecAttrEntry> ParseAttrChildren(JsonElement owner)
    {
        var outList = new List<SpecAttrEntry>();
        if (!owner.TryGetProperty("children", out JsonElement children) || children.ValueKind != JsonValueKind.Array)
        {
            return outList;
        }
        foreach (JsonElement c in children.EnumerateArray())
        {
            if (Str(c, "type") != AttrChildType)
            {
                continue; // structural child — parsed separately; B1 reads only attr docs
            }
            (int? min, int? max, bool maxIsNull) = Cardinality(c);
            IReadOnlyList<string>? allowed = null;
            if (c.TryGetProperty("allowedValues", out JsonElement av) && av.ValueKind == JsonValueKind.Array)
            {
                allowed = av.EnumerateArray().Select(x => x.GetString()!).ToList();
            }
            object? def = null;
            if (c.TryGetProperty("default", out JsonElement defEl) && defEl.ValueKind != JsonValueKind.Null)
            {
                def = defEl.ValueKind switch
                {
                    JsonValueKind.String => defEl.GetString(),
                    JsonValueKind.True => true,
                    JsonValueKind.False => false,
                    JsonValueKind.Number => defEl.GetRawText(),
                    _ => defEl.GetRawText(),
                };
            }
            outList.Add(new SpecAttrEntry(
                Name: Str(c, "name")!,
                SubType: Str(c, "subType"),
                IsArray: Bool(c, "isArray"),
                Min: min,
                Max: max,
                MaxIsNull: maxIsNull,
                Description: Str(c, "description"),
                Rules: Str(c, "rules"),
                Example: Str(c, "example"),
                WhenToUse: Str(c, "whenToUse"),
                AllowedValues: allowed,
                Default: def));
        }
        return outList;
    }

    private static List<SpecStructChild> ParseStructChildren(JsonElement owner)
    {
        var outList = new List<SpecStructChild>();
        if (!owner.TryGetProperty("children", out JsonElement children) || children.ValueKind != JsonValueKind.Array)
        {
            return outList;
        }
        foreach (JsonElement c in children.EnumerateArray())
        {
            string? childType = Str(c, "type");
            if (childType is null || childType == AttrChildType)
            {
                continue; // attr children are the attrs block (B1) — not structural
            }
            (int? min, int? max, bool maxIsNull) = Cardinality(c);
            bool? named = null;
            if (c.TryGetProperty("named", out JsonElement n) && n.ValueKind != JsonValueKind.Null)
            {
                named = n.GetBoolean();
            }
            outList.Add(new SpecStructChild(
                ChildType: childType,
                ChildSubType: Str(c, "subType") ?? Wildcard,
                ChildName: Str(c, "name") ?? Wildcard,
                Min: min,
                Max: max,
                MaxIsNull: maxIsNull,
                Named: named));
        }
        return outList;
    }

    private static (int? Min, int? Max, bool MaxIsNull) Cardinality(JsonElement c)
    {
        int? min = null;
        if (c.TryGetProperty("min", out JsonElement minEl) && minEl.ValueKind == JsonValueKind.Number)
        {
            min = minEl.GetInt32();
        }
        int? max = null;
        bool maxIsNull = false;
        if (c.TryGetProperty("max", out JsonElement maxEl))
        {
            if (maxEl.ValueKind == JsonValueKind.Null)
            {
                maxIsNull = true;
            }
            else if (maxEl.ValueKind == JsonValueKind.Number)
            {
                max = maxEl.GetInt32();
            }
        }
        return (min, max, maxIsNull);
    }

    // ------------------------------------------------------------------
    // Lookup surface (B1)
    // ------------------------------------------------------------------

    /// <summary>The <c>(type, subType)</c> doc facet, or <see langword="null"/> when the JSON has no such entry.</summary>
    public SpecDocFacet? TypeDoc(string type, string subType) =>
        _typeDocs.TryGetValue(Key(type, subType), out SpecDocFacet? f) ? f : null;

    /// <summary>
    /// Resolve an attr's doc entry for a <c>(type, subType)</c> — exact
    /// <c>types[].children</c> entry first, then any matching <c>extends</c> block, then
    /// the <c>&lt;type&gt;.base</c> fallback (the JSON's <c>extendsBase</c> inheritance).
    /// <see langword="null"/> when no JSON source declares this attr for this subtype.
    /// </summary>
    public SpecAttrEntry? AttrDoc(string type, string subType, string attrName)
    {
        SpecAttrEntry? exact = AttrDocExact(type, subType, attrName);
        if (exact is not null)
        {
            return exact;
        }
        if (subType != BaseSubType)
        {
            return AttrDocExact(type, BaseSubType, attrName);
        }
        return null;
    }

    private SpecAttrEntry? AttrDocExact(string type, string subType, string attrName)
    {
        if (_typeAttrDocs.TryGetValue(Key(type, subType), out Dictionary<string, SpecAttrEntry>? direct)
            && direct.TryGetValue(attrName, out SpecAttrEntry? a))
        {
            return a;
        }
        foreach (ExtendsBlock b in _extendsBlocks)
        {
            if (b.Type != type)
            {
                continue;
            }
            if ((b.WildcardSubType || b.SubTypes.Contains(subType))
                && b.Attrs.TryGetValue(attrName, out SpecAttrEntry? ea))
            {
                return ea;
            }
        }
        return null;
    }

    /// <summary>The universal <c>*.*</c> common-attr doc entry by name, or <see langword="null"/>.</summary>
    public SpecAttrEntry? CommonAttrDoc(string name) =>
        _commonAttrDocs.TryGetValue(name, out SpecAttrEntry? a) ? a : null;

    /// <summary>
    /// Whether the JSON declares this <c>(type, subType)</c> at all (so a caller can
    /// distinguish "described with an empty children list" from "absent from the spec",
    /// e.g. <c>metadata.root</c>).
    /// </summary>
    public bool IsDeclared(string type, string subType) => _declaredKeys.Contains(Key(type, subType));

    // ------------------------------------------------------------------
    // Strict constraint surface (B2 — parsed now, consumed by S-B2)
    // ------------------------------------------------------------------

    /// <summary>
    /// FR-033 (sub-step B2a) — the STRICT structural children for <c>(type, subType)</c>,
    /// composed with <c>&lt;type&gt;.base</c> when the subtype carries <c>extendsBase: true</c>
    /// (the TS <c>composeWithBase</c> rule: base children ∪ own children, additively).
    /// Mirrors the Java/Python reader. (Parsed for S-B2; B1 does not consume it.)
    /// </summary>
    public IReadOnlyList<SpecStructChild> StructuralChildren(string type, string subType)
    {
        string key = Key(type, subType);
        List<SpecStructChild> own = _typeStructChildren.TryGetValue(key, out List<SpecStructChild>? o) ? o : new();
        bool extendsBase = _typeExtendsBase.TryGetValue(key, out bool eb) && eb;
        if (!extendsBase || subType == BaseSubType)
        {
            return new List<SpecStructChild>(own);
        }
        List<SpecStructChild> baseChildren = _typeStructChildren.TryGetValue(Key(type, BaseSubType), out List<SpecStructChild>? bc)
            ? bc : new();
        var merged = new Dictionary<string, SpecStructChild>(StringComparer.Ordinal);
        foreach (SpecStructChild b in baseChildren)
        {
            merged[StructKey(b)] = b;
        }
        foreach (SpecStructChild s in own)
        {
            merged[StructKey(s)] = s; // own wins on overlap
        }
        return merged.Values.ToList();
    }

    /// <summary>
    /// FR-033 (sub-step B2b) — the STRICT per-subtype attr-name allow-list for
    /// <c>(type, subType)</c>: own attrs ∪ <c>&lt;type&gt;.base</c> attrs (when
    /// <c>extendsBase</c>) ∪ every matching <c>extends</c> block. Mirrors the
    /// Java/Python reader. (Parsed for S-B2; B1 does not consume it.)
    /// </summary>
    public ISet<string> StrictAttrNames(string type, string subType)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        if (_typeAttrDocs.TryGetValue(Key(type, subType), out Dictionary<string, SpecAttrEntry>? own))
        {
            names.UnionWith(own.Keys);
        }
        bool extendsBase = _typeExtendsBase.TryGetValue(Key(type, subType), out bool eb) && eb;
        if (extendsBase && subType != BaseSubType
            && _typeAttrDocs.TryGetValue(Key(type, BaseSubType), out Dictionary<string, SpecAttrEntry>? baseAttrs))
        {
            names.UnionWith(baseAttrs.Keys);
        }
        foreach (ExtendsBlock b in _extendsBlocks)
        {
            if (b.Type != type)
            {
                continue;
            }
            if (b.WildcardSubType || b.SubTypes.Contains(subType))
            {
                names.UnionWith(b.Attrs.Keys);
            }
        }
        return names;
    }

    // ------------------------------------------------------------------

    private static string StructKey(SpecStructChild c) => $"{c.ChildType} {c.ChildSubType} {c.ChildName}";

    private static string Key(string type, string subType) => $"{type}.{subType}";

    private static string? Str(JsonElement o, string k) =>
        o.TryGetProperty(k, out JsonElement e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;

    private static bool Bool(JsonElement o, string k) =>
        o.TryGetProperty(k, out JsonElement e) && e.ValueKind == JsonValueKind.True;
}
