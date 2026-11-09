// Phase 5 bug R-walk — a `@via` hop may walk an identity.reference BACKWARDS, from the entity
// it targets to the entity that declares it, with no relationship declared for it. Ported from
// typescript/packages/metadata/src/core/relationship/find-reference.ts (reverseHopName,
// findReverseReferenceHops); the loader corpus fixtures/conformance/origin-reverse-reference-hop
// and error-origin-reverse-hop-ambiguous pin both ports to the same rule.

using static MetaObjects.Core.Identity.IdentityConstants;

namespace MetaObjects.Meta;

/// <summary>A reverse <c>@via</c> hop: the reference walked backwards and the object that declares it.</summary>
public sealed record ReverseReferenceHop(MetaObject Holder, MetaReferenceIdentity Reference);

public static class ReverseReferenceHops
{
    /// <summary>
    /// The name a reverse hop takes: the holder's collection name (its @collectionName, else the project's pluralizer), lowerFirst —
    /// <c>consents</c> for <c>Consent</c>. The pluralization is the one every port shares
    /// (already-plural names stay; else the suffix rule), as <c>fixtures/naming-conformance</c> pins it.
    /// </summary>
    public static string HopName(MetaObject holder)
    {
        // rc.19 (R57): the holder's collection name — its @collectionName, else the project's pluralizer.
        var plural = CollectionNames.Of(holder);
        return plural.Length == 0 ? plural : char.ToLowerInvariant(plural[0]) + plural[1..];
    }

    /// <summary>
    /// Every identity.reference that targets <paramref name="target"/> from a concrete object whose
    /// <see cref="HopName"/> is <paramref name="hopName"/>. One is the hop; none means the hop is not a
    /// reverse; more than one is ambiguous. A declared relationship or reference of the same name on
    /// the target always wins; callers look those up first.
    /// </summary>
    public static IReadOnlyList<ReverseReferenceHop> Find(MetaObject target, string hopName, IEnumerable<MetaObject> objects)
    {
        var found = new List<ReverseReferenceHop>();
        foreach (var holder in objects)
        {
            if (holder.IsAbstract || HopName(holder) != hopName) continue;
            foreach (var r in holder.ReferenceIdentities())
                // ADR-0059 R7: compare the bound target, never a short name.
                if (ReferenceEquals(NamingRefs.RefTarget(r, IDENTITY_REFERENCE_ATTR_REFERENCES), target))
                    found.Add(new ReverseReferenceHop(holder, r));
        }
        return found;
    }
}
