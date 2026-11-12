// A projection @filter key may be a PATH: to-one hops from
// the base entity, then a field of the entity they reach (`caseId.status`). A hop is an
// identity.reference or a relationship with @cardinality one; a to-many hop is refused. Ported
// from typescript/packages/metadata/src/core/relationship/filter-path.ts.

using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Core.Relationship.RelationshipConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Meta;

/// <summary>A resolved filter path: the hop names walked, the entity reached, and its field.</summary>
public sealed record FilterPath(IReadOnlyList<string> Hops, MetaObject Entity, MetaData Field);

public static class FilterPaths
{
    /// <summary>
    /// Resolve a dotted filter key against <paramref name="baseEntity"/>. Null when the key has no
    /// dot; otherwise the path, or the reason it does not resolve in <paramref name="error"/>.
    /// </summary>
    public static FilterPath? Resolve(MetaObject baseEntity, string key, out string? error)
    {
        error = null;
        var segments = key.Split('.');
        if (segments.Length < 2) return null;
        var current = baseEntity;
        foreach (var hop in segments[..^1])
        {
            var reference = current.Children().FirstOrDefault(c =>
                c.Type == TYPE_IDENTITY && c.SubType == IDENTITY_SUBTYPE_REFERENCE && c.Name == hop);
            MetaObject? next;
            if (reference is not null)
            {
                next = NamingRefs.RefTarget(reference, IDENTITY_REFERENCE_ATTR_REFERENCES) as MetaObject;
                if (next is null) { error = $"reference \"{current.Name}.{hop}\" does not resolve"; return null; }
            }
            else if (current.Children().FirstOrDefault(c => c.Type == TYPE_RELATIONSHIP && c.Name == hop) is { } rel)
            {
                if (rel.Attr(RELATIONSHIP_ATTR_CARDINALITY) as string != CARDINALITY_ONE)
                {
                    error = $"\"{current.Name}.{hop}\" is to-many; a filter path may only walk to-one hops";
                    return null;
                }
                next = NamingRefs.RefTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF) as MetaObject;
                if (next is null) { error = $"relationship \"{current.Name}.{hop}\" does not resolve"; return null; }
            }
            else
            {
                error = $"\"{current.Name}\" declares no identity.reference or to-one relationship named \"{hop}\"";
                return null;
            }
            current = next;
        }
        var fieldName = segments[^1];
        var field = current.Children().FirstOrDefault(c => c.Type == TYPE_FIELD && c.Name == fieldName);
        if (field is null) { error = $"\"{current.Name}\" declares no field \"{fieldName}\""; return null; }
        return new FilterPath(segments[..^1], current, field);
    }
}
