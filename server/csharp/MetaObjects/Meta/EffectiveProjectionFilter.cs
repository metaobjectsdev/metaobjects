// rc.19 (C1) — a projection's EFFECTIVE row scope. `@filter` composes down an `extends` chain
// rather than overriding: a projection that extends a filtered projection keeps the base's row
// scope (a consent gate on an abstract base must survive in every extender). Every level's own
// `@filter`, root-most first, ANDed. Ported from
// typescript/packages/metadata/src/core/object/effective-projection-filter.ts.

using static MetaObjects.Core.Object.ObjectConstants;
using static MetaObjects.Core.Query.QueryConstants;

namespace MetaObjects.Meta;

public static class ProjectionFilters
{
    /// <summary>
    /// The <c>@filter</c> a projection's view applies: its own and every super's, root-most
    /// first. One declaration is returned as declared; two or more are ANDed in one flat
    /// <c>{ and: [...] }</c>. Null when no level declares one.
    /// </summary>
    public static object? Effective(MetaData projection)
    {
        var levels = new List<object?>();
        var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        for (var node = projection; node is not null && seen.Add(node); node = node.SuperData)
        {
            // ADR-0039: own — each level contributes the @filter declared on it; the resolving
            // read would return only the nearest one, which is the override this replaces.
            if (node.OwnAttr(OBJECT_PROJECTION_ATTR_FILTER) is { } own) levels.Insert(0, own);
        }
        if (levels.Count <= 1) return levels.Count == 0 ? null : levels[0];
        var members = new List<object?>();
        foreach (var level in levels) members.AddRange(AndMembers(level));
        return new Dictionary<string, object?> { [FILTER_COMPOSE_AND] = members };
    }

    /// <summary>A level that is itself a bare <c>{ and: [...] }</c> contributes its members.</summary>
    private static IEnumerable<object?> AndMembers(object? filter) =>
        filter is IReadOnlyDictionary<string, object?> { Count: 1 } map
            && map.TryGetValue(FILTER_COMPOSE_AND, out var subs) && subs is IReadOnlyList<object?> list
            ? list
            : [filter];
}
