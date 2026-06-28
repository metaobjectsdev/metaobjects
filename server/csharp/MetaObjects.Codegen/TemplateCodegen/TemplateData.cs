using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.TemplateCodegen;

/// <summary>
/// The NEUTRAL, structural codegen template data dict (SP-1 §3.2) for C#.
/// <see cref="Dictionary{TKey,TValue}"/> graphs mirroring the TS keys EXACTLY — a
/// byte-gated cross-port contract (verified against the TS-produced
/// <c>fixtures/template-codegen-conformance/expected/</c>). Optional keys
/// (<c>maxLength</c>, <c>enumValues</c>) are OMITTED when absent so a
/// <c>{{#maxLength}}</c> section gates identically to TS.
///
/// Own-vs-effective discipline (matching the TS ownAttr semantics, per the JVM +
/// Python reviews — both rounds): <c>IsAbstract</c> per-node; <c>@required</c> attr,
/// <c>maxLength</c>, identity <c>fields</c>, relationship <c>cardinality</c>/<c>objectRef</c>
/// via own-only attrs; the required-<i>validator</i> branch + enum <c>values</c> effective.
/// </summary>
public static class TemplateData
{
    private const string SubtypeEnum = "enum";

    public static string BareName(MetaObject o) => o.Name;

    /// <summary>Effective package — own package or file-default — derived from
    /// <see cref="MetaData.ResolutionKey"/> (<c>pkg::Name</c>); "" when none.</summary>
    public static string PackageOf(MetaObject o)
    {
        var key = o.ResolutionKey();
        var suffix = "::" + o.Name;
        return key.EndsWith(suffix, StringComparison.Ordinal) ? key[..^suffix.Length] : "";
    }

    public static bool IsConcrete(MetaObject o) => !o.IsAbstract;

    private static bool Required(MetaField f) =>
        f.OwnAttr("required") is true || f.Validators().Any(v => v.IsRequired());

    private static List<string> ToStringList(object? raw) =>
        raw is IEnumerable en and not string
            ? en.Cast<object?>().Select(x => x?.ToString() ?? "").ToList()
            : new List<string>();

    private static Dictionary<string, object?> FieldData(MetaField f)
    {
        var d = new Dictionary<string, object?>
        {
            ["name"] = f.Name,
            ["type"] = f.SubType,
            ["required"] = Required(f),
            ["isArray"] = f.IsArray,
        };
        if (f.OwnHasAttr("maxLength"))
            d["maxLength"] = Convert.ToInt32(f.OwnAttr("maxLength"));
        if (f.SubType == SubtypeEnum && f.HasAttr("values"))
            d["enumValues"] = ToStringList(f.Attr("values"));
        return d;
    }

    public static Dictionary<string, object?> Entity(MetaObject o)
    {
        var identities = o.Identities().Select(id => new Dictionary<string, object?>
        {
            ["kind"] = id.SubType,
            ["fields"] = ToStringList(id.OwnAttr("fields")),
        }).ToList();

        var relationships = o.Relationships().Select(r => new Dictionary<string, object?>
        {
            ["name"] = r.Name,
            ["cardinality"] = r.OwnAttr("cardinality") as string ?? "",
            ["targetRef"] = r.OwnAttr("objectRef") as string ?? "",
        }).ToList();

        return new Dictionary<string, object?>
        {
            ["name"] = BareName(o),
            ["package"] = PackageOf(o),
            ["fields"] = o.Fields().Select(FieldData).ToList(),
            ["identities"] = identities,
            ["relationships"] = relationships,
        };
    }

    public static Dictionary<string, object?> Package(string pkg, IReadOnlyList<MetaObject> entities) =>
        new()
        {
            ["package"] = pkg,
            ["entities"] = entities.Select(Entity).ToList(),
        };

    /// <summary>Concrete-only, grouped by package ascending, entities in iteration order.</summary>
    public static Dictionary<string, object?> Model(IReadOnlyList<MetaObject> objects)
    {
        var byPkg = new SortedDictionary<string, List<MetaObject>>(StringComparer.Ordinal);
        foreach (var o in objects)
        {
            if (!IsConcrete(o)) continue;
            if (!byPkg.TryGetValue(PackageOf(o), out var list))
                byPkg[PackageOf(o)] = list = new List<MetaObject>();
            list.Add(o);
        }
        return new Dictionary<string, object?>
        {
            ["packages"] = byPkg.Select(kv => Package(kv.Key, kv.Value)).ToList(),
        };
    }
}
