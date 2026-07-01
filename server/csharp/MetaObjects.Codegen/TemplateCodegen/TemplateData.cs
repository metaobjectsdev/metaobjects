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
/// Own-vs-effective discipline (matching TS exactly, ADR-0039): <c>IsAbstract</c> is
/// per-node; the required-<i>validator</i> branch + enum <c>values</c> + <c>@required</c>
/// + <c>maxLength</c> + <c>isArray</c> + identity <c>fields</c> + relationship
/// <c>cardinality</c>/<c>objectRef</c> are all EFFECTIVE (resolving) — TS reads these via
/// the resolving <c>i.fields</c> / <c>r.cardinality</c> / <c>r.objectRef</c> getters, so C#
/// reads through the matching resolving typed getters (<see cref="MetaIdentity.Fields"/> /
/// <see cref="MetaRelationship.Cardinality"/> / <see cref="MetaRelationship.ObjectRef"/>).
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

    // ADR-0039: resolving — delegate to the field's resolving IsRequired getter
    // (@required and the validator set are both effective forms).
    private static bool Required(MetaField f) => f.IsRequired;

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
            // ADR-0039: resolving array-ness (inheritable via extends).
            ["isArray"] = f.ResolvedIsArray(),
        };
        // ADR-0039: resolving — @maxLength may be inherited via extends (MaxLength getter resolves).
        if (f.MaxLength is { } ml)
            d["maxLength"] = Convert.ToInt32(ml);
        if (f.SubType == SubtypeEnum && f.HasAttr("values"))
            d["enumValues"] = ToStringList(f.Attr("values"));
        return d;
    }

    public static Dictionary<string, object?> Entity(MetaObject o)
    {
        var identities = o.Identities().Select(id => new Dictionary<string, object?>
        {
            ["kind"] = id.SubType,
            // ADR-0039: resolving — identity @fields may be inherited via extends (TS reads i.fields).
            ["fields"] = id.Fields.ToList(),
        }).ToList();

        var relationships = o.Relationships().Select(r => new Dictionary<string, object?>
        {
            ["name"] = r.Name,
            // ADR-0039: resolving — @cardinality/@objectRef may be inherited (TS reads r.cardinality/r.objectRef).
            ["cardinality"] = r.Cardinality ?? "",
            ["targetRef"] = r.ObjectRef ?? "",
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
