// The metamodel reference pages' data: what the shared Mustache templates
// (`templates/metamodel/`) render as `INDEX.md`, `providers.md` and one `types/<family>.md`
// per type family. C# port of the TypeScript reference `buildMetamodelDocsPages`
// (server/typescript/packages/metadata/src/metamodel-docs/pages.ts).
//
// Two inputs this port already holds: its registry vocabulary manifest (RegistryManifest.Emit,
// byte-matched across the ports by registry-conformance) and its embedded provider definitions
// (spec/metamodel/*.json, which alone say which provider OWNS a type and CONTRIBUTES an attr).
// The builder makes every decision (sorting, table cells, joined lists, links); a template only
// lays the lines out. The data is pinned by fixtures/metamodel-docs/data/.
//
// Lives in the core assembly, not in an ejectable generator: it decides what there is to emit.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects;

/// <summary>One page to render: its output path (relative), its template ref and the template's data.</summary>
public sealed record MetamodelDocsPage(string Path, string Template, Dictionary<string, object?> Data);

public static class MetamodelDocsPages
{
    /// <summary>The shared template of <c>INDEX.md</c>.</summary>
    public const string IndexPageRef = "metamodel/index.md";
    /// <summary>The shared template of <c>providers.md</c>.</summary>
    public const string ProvidersPageRef = "metamodel/providers.md";
    /// <summary>The shared template of each <c>types/&lt;family&gt;.md</c>.</summary>
    public const string TypePageRef = "metamodel/type-page.md";

    private const string Wildcard = "*";
    private const string AttrChildType = "attr";
    private const string SubTypeBase = "base";
    private const string NoValue = "—";

    /// <summary>The definition files, in the order TypeScript walks them (first declarer wins).</summary>
    public static readonly IReadOnlyList<string> DefinitionFiles =
    [
        "field", "object", "attr", "validator", "identity", "index", "relationship", "documentation",
        "origin", "source", "db", "view", "layout", "ui", "ui-web", "template", "prompt", "api",
        "transition", "view-expressions", "reporting", "requirement",
    ];

    private const string ResourcePrefix = "MetaObjects.SpecMetamodel.";

    /// <summary>The pages for this build's own registry and embedded provider definitions.</summary>
    public static IReadOnlyList<MetamodelDocsPage> BuildBuiltIn(IReadOnlyDictionary<string, string> providerDescriptions)
    {
        var registry = Provider.ComposeRegistry(CoreTypes.LibraryProviders);
        var asm = typeof(MetamodelDocsPages).Assembly;
        var defs = new List<string>();
        foreach (var name in DefinitionFiles)
        {
            using var stream = asm.GetManifestResourceStream(ResourcePrefix + name + ".json")
                ?? throw new InvalidOperationException($"embedded provider definition missing: {name}.json");
            using var reader = new StreamReader(stream);
            defs.Add(reader.ReadToEnd());
        }
        return Build(RegistryManifest.Emit(registry), defs, providerDescriptions);
    }

    /// <summary>Every page, in output order: INDEX.md, providers.md, then one <c>types/&lt;family&gt;.md</c>
    /// per type family, sorted. Documentation (common) attrs are left off the type pages.</summary>
    public static IReadOnlyList<MetamodelDocsPage> Build(
        string manifestJson, IEnumerable<string> definitionJson, IReadOnlyDictionary<string, string> providerDescriptions)
    {
        using var manifestDoc = JsonDocument.Parse(manifestJson);
        var defDocs = definitionJson.Select(j => JsonDocument.Parse(j)).ToList();
        try
        {
            var manifest = manifestDoc.RootElement;
            var types = manifest.GetProperty("types").EnumerateArray().ToList();
            var p = BuildProvenance(types, defDocs.Select(d => d.RootElement));
            var common = manifest.GetProperty("commonAttrs").EnumerateArray()
                .Select(a => a.GetProperty("name").GetString()!).ToHashSet(StringComparer.Ordinal);

            var pages = new List<MetamodelDocsPage>
            {
                new("INDEX.md", IndexPageRef, IndexData(types)),
                new("providers.md", ProvidersPageRef, ProvidersData(p, providerDescriptions)),
            };
            var byFamily = new Dictionary<string, List<JsonElement>>(StringComparer.Ordinal);
            foreach (var t in types)
            {
                var family = Str(t, "type");
                if (!byFamily.TryGetValue(family, out var list)) byFamily[family] = list = [];
                list.Add(t);
            }
            foreach (var family in byFamily.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                pages.Add(new($"types/{family}.md", TypePageRef, new Dictionary<string, object?>
                {
                    ["family"] = family,
                    ["sections"] = byFamily[family].Select(t => (object?)SectionData(t, p, common)).ToList(),
                }));
            }
            return pages;
        }
        finally
        {
            foreach (var d in defDocs) d.Dispose();
        }
    }

    // ---- helpers -------------------------------------------------------------

    private static string Str(JsonElement e, string name) => e.GetProperty(name).GetString()!;

    private static string? OptStr(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int Ord(string a, string b) => string.CompareOrdinal(a, b);

    /// <summary>Escape a markdown table cell: collapse newlines, escape pipes.</summary>
    private static string Cell(string s) =>
        Regex.Replace(s, "\r?\n", " ").Replace("|", "\\|").Trim();

    /// <summary>The anchor GitHub assigns to a <c>### field.currency</c> heading: <c>fieldcurrency</c>.</summary>
    private static string Anchor(string type, string subType) =>
        Regex.Replace((type + subType).ToLowerInvariant(), "[^a-z0-9]", "");

    /// <summary>A value as an inline-code token (JavaScript <c>String(v)</c>); nothing for no value.</summary>
    private static string ValueToken(JsonElement? v)
    {
        if (v is not { } e || e.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return "";
        var text = e.ValueKind switch
        {
            JsonValueKind.String => e.GetString()!,
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number => e.TryGetInt64(out var l)
                ? l.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : e.GetDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture),
            _ => e.GetRawText(),
        };
        return $"`{text}`";
    }

    private static string CodeList(IEnumerable<string> items, string prefix = "") =>
        string.Join(", ", items.Select(i => $"`{prefix}{i}`"));

    private static List<string> Sorted(IEnumerable<string> items)
    {
        var l = items.ToList();
        l.Sort(Ord);
        return l;
    }

    // ---- provenance ----------------------------------------------------------

    private sealed record AttrProvenance(string Provider, JsonElement? Default);

    private sealed class Provenance
    {
        public readonly Dictionary<string, string> OwnerOfType = new(StringComparer.Ordinal);
        public readonly Dictionary<string, AttrProvenance> Attrs = new(StringComparer.Ordinal);
        public List<string> ProviderIds = [];
        public readonly Dictionary<string, HashSet<string>> Owned = new(StringComparer.Ordinal);
        public readonly Dictionary<string, Dictionary<string, HashSet<string>>> Contributed = new(StringComparer.Ordinal);
        public readonly Dictionary<string, HashSet<string>> Common = new(StringComparer.Ordinal);
    }

    private static bool IsUniversal(JsonElement t) =>
        OptStr(t, "type") == Wildcard && OptStr(t, "subType") == Wildcard;

    private static IEnumerable<JsonElement> AttrChildren(JsonElement t) =>
        t.TryGetProperty("children", out var c) && c.ValueKind == JsonValueKind.Array
            ? c.EnumerateArray().Where(x => OptStr(x, "type") == AttrChildType)
            : [];

    private static IEnumerable<JsonElement> Items(JsonElement def, string name) =>
        def.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];

    /// <summary>Walk the provider definitions: non-universal <c>types[]</c> are OWNED, <c>extends[]</c>
    /// are contributed attrs (<c>"*"</c> resolves to the manifest's subtypes), the universal <c>*.*</c>
    /// entry's attrs are COMMON. The first declarer of an attr on a type wins.</summary>
    private static Provenance BuildProvenance(List<JsonElement> manifestTypes, IEnumerable<JsonElement> definitions)
    {
        var covered = manifestTypes.Select(t => $"{Str(t, "type")}.{Str(t, "subType")}").ToHashSet(StringComparer.Ordinal);
        var subTypesOf = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var t in manifestTypes)
        {
            var type = Str(t, "type");
            if (!subTypesOf.TryGetValue(type, out var l)) subTypesOf[type] = l = [];
            l.Add(Str(t, "subType"));
        }

        var p = new Provenance();
        var ids = new HashSet<string>(StringComparer.Ordinal);

        void Record(string id, string type, string subType, JsonElement c)
        {
            var key = $"{type}.{subType}.{Str(c, "name")}";
            if (!p.Attrs.ContainsKey(key))
                p.Attrs[key] = new AttrProvenance(id, c.TryGetProperty("default", out var d) ? d.Clone() : null);
            var byType = p.Contributed[id];
            var tk = $"{type}.{subType}";
            if (!byType.TryGetValue(tk, out var set)) byType[tk] = set = new(StringComparer.Ordinal);
            set.Add(Str(c, "name"));
        }

        foreach (var def in definitions)
        {
            var id = Str(def, "provider");
            if (ids.Add(id))
            {
                p.Owned[id] = new(StringComparer.Ordinal);
                p.Contributed[id] = new(StringComparer.Ordinal);
                p.Common[id] = new(StringComparer.Ordinal);
            }
            foreach (var t in Items(def, "types"))
            {
                if (IsUniversal(t))
                {
                    foreach (var c in AttrChildren(t)) p.Common[id].Add(Str(c, "name"));
                    continue;
                }
                var type = Str(t, "type");
                var subType = Str(t, "subType");
                var tk = $"{type}.{subType}";
                if (!p.OwnerOfType.ContainsKey(tk)) p.OwnerOfType[tk] = id;
                if (covered.Contains(tk)) p.Owned[id].Add(tk);
                foreach (var c in AttrChildren(t)) Record(id, type, subType, c);
            }
            foreach (var ext in Items(def, "extends"))
            {
                var type = Str(ext, "type");
                var st = ext.GetProperty("subType");
                IEnumerable<string> subTypes = st.ValueKind == JsonValueKind.Array
                    ? st.EnumerateArray().Select(x => x.GetString()!).ToList()
                    : st.GetString() == Wildcard
                        ? (subTypesOf.TryGetValue(type, out var all) ? all : [])
                        : [st.GetString()!];
                foreach (var subType in subTypes)
                    foreach (var c in AttrChildren(ext)) Record(id, type, subType, c);
            }
        }
        p.ProviderIds = Sorted(ids);
        return p;
    }

    // ---- page data -----------------------------------------------------------

    private static Dictionary<string, object?> IndexData(List<JsonElement> types) => new()
    {
        ["rows"] = types.Select(t => (object?)new Dictionary<string, object?>
        {
            ["typeSubType"] = $"{Str(t, "type")}.{Str(t, "subType")}",
            ["description"] = Cell(Str(t, "description")),
            ["page"] = $"types/{Str(t, "type")}.md#{Anchor(Str(t, "type"), Str(t, "subType"))}",
        }).ToList(),
    };

    private static Dictionary<string, object?> ProvidersData(Provenance p, IReadOnlyDictionary<string, string> descriptions)
    {
        var providers = new List<object?>();
        foreach (var id in p.ProviderIds)
        {
            var hasDescription = descriptions.TryGetValue(id, out var description);
            var owned = Sorted(p.Owned[id]);
            var common = Sorted(p.Common[id]);
            var contributed = p.Contributed[id].OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => (object?)new Dictionary<string, object?>
                {
                    ["typeSubType"] = kv.Key,
                    ["attrs"] = CodeList(Sorted(kv.Value), "@"),
                }).ToList();
            var d = new Dictionary<string, object?> { ["id"] = id, ["hasDescription"] = hasDescription };
            if (hasDescription) d["description"] = description;
            d["hasOwns"] = owned.Count > 0;
            if (owned.Count > 0) d["owns"] = CodeList(owned);
            d["hasUniversal"] = common.Count > 0;
            if (common.Count > 0) d["universal"] = CodeList(common, "@");
            d["hasContributes"] = contributed.Count > 0;
            d["contributes"] = contributed;
            providers.Add(d);
        }
        return new() { ["providers"] = providers };
    }

    private static string ChildLine(JsonElement rule)
    {
        var childName = Str(rule, "childName");
        var nameSuffix = childName == Wildcard ? "" : $" (name `{childName}`)";
        var st = rule.GetProperty("childSubType");
        var subLabel = st.ValueKind == JsonValueKind.String
            ? st.GetString()!
            : string.Join(", ", st.EnumerateArray().Select(x => x.GetString()));
        var min = rule.TryGetProperty("min", out var mn) && mn.ValueKind == JsonValueKind.Number ? mn.GetInt32() : 0;
        var max = rule.TryGetProperty("max", out var mx) && mx.ValueKind == JsonValueKind.Number
            ? mx.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture)
            : "*";
        return $"`{Str(rule, "childType")}.{subLabel}`{nameSuffix} — {min}..{max}";
    }

    private static Dictionary<string, object?> SectionData(JsonElement t, Provenance p, HashSet<string> commonAttrNames)
    {
        var type = Str(t, "type");
        var subType = Str(t, "subType");
        var owner = p.OwnerOfType.TryGetValue($"{type}.{subType}", out var o) ? o : null;

        // An attr inherited from `<type>.base` is recorded against the BASE in the definitions.
        var attrs = new List<object?>();
        foreach (var a in t.GetProperty("attrs").EnumerateArray())
        {
            var name = Str(a, "name");
            if (commonAttrNames.Contains(name)) continue;
            if (!p.Attrs.TryGetValue($"{type}.{subType}.{name}", out var prov))
                p.Attrs.TryGetValue($"{type}.{SubTypeBase}.{name}", out prov);
            var valueType = a.TryGetProperty("valueType", out var vt) && vt.ValueKind == JsonValueKind.String ? vt.GetString()! : "any";
            var isArray = a.TryGetProperty("isArray", out var ia) && ia.ValueKind == JsonValueKind.True;
            var required = a.TryGetProperty("required", out var rq) && rq.ValueKind == JsonValueKind.True;
            var allowed = a.TryGetProperty("allowedValues", out var av) && av.ValueKind == JsonValueKind.Array
                ? string.Join(", ", av.EnumerateArray().Select(x => ValueToken(x)))
                : "";
            attrs.Add(new Dictionary<string, object?>
            {
                ["name"] = name,
                ["type"] = isArray ? valueType + "[]" : valueType,
                ["required"] = required ? "yes" : "no",
                ["default"] = ValueToken(prov?.Default),
                ["allowed"] = allowed,
                ["provider"] = prov?.Provider ?? NoValue,
                ["description"] = Cell(Str(a, "description")),
            });
        }
        var children = (t.TryGetProperty("children", out var ch) ? ch.EnumerateArray() : [])
            .Where(c => Str(c, "childType") != AttrChildType).Select(c => (object?)ChildLine(c)).ToList();
        var implementedIn = t.TryGetProperty("implementedIn", out var ii) ? Sorted(ii.EnumerateArray().Select(x => x.GetString()!)) : [];
        var parents = t.TryGetProperty("parents", out var pa) ? Sorted(pa.EnumerateArray().Select(x => x.GetString()!)) : [];

        var d = new Dictionary<string, object?>
        {
            ["typeSubType"] = $"{type}.{subType}",
            ["description"] = Str(t, "description"),
            ["hasOwner"] = owner is not null,
        };
        if (owner is not null) d["owner"] = owner;
        d["hasImplementedIn"] = implementedIn.Count > 0;
        if (implementedIn.Count > 0) d["implementedIn"] = string.Join(", ", implementedIn);
        foreach (var (flag, key) in new[] { ("hasRules", "rules"), ("hasWhenToUse", "whenToUse"), ("hasExample", "example") })
        {
            var v = OptStr(t, key);
            d[flag] = v is not null;
            if (v is not null) d[key] = v;
        }
        d["hasAttrs"] = attrs.Count > 0;
        d["attrs"] = attrs;
        d["hasChildren"] = children.Count > 0;
        d["children"] = children;
        d["hasParents"] = parents.Count > 0;
        if (parents.Count > 0) d["parents"] = CodeList(parents);
        return d;
    }
}
