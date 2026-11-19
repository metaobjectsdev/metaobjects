// A `@via` hop may walk an identity.reference BACKWARDS, from the entity
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
        // The holder's collection name — its @collectionName, else the project's pluralizer.
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

    /// <summary>
    /// rc.21 — every reverse hop a <c>@via</c> may take from <paramref name="target"/>: one per
    /// identity.reference onto it from a concrete object, under that object's <see cref="HopName"/>.
    /// For the "no such relationship" message, so an author who guessed a hop name (the reference's
    /// own name, a plural the holder's <c>@collectionName</c> overrides) sees the one the rule gives.
    /// </summary>
    public static IReadOnlyList<(string HopName, ReverseReferenceHop Hop)> OnTo(MetaObject target, IEnumerable<MetaObject> objects)
    {
        var found = new List<(string, ReverseReferenceHop)>();
        foreach (var holder in objects)
        {
            if (holder.IsAbstract) continue;
            foreach (var r in holder.ReferenceIdentities())
                // ADR-0059 R7: compare the bound target, never a short name.
                if (ReferenceEquals(NamingRefs.RefTarget(r, IDENTITY_REFERENCE_ATTR_REFERENCES), target))
                    found.Add((HopName(holder), new ReverseReferenceHop(holder, r)));
        }
        return found;
    }

    /// <summary>The message suffix naming <see cref="OnTo"/>'s hops, or <c>""</c> when there are none.</summary>
    public static string Hint(MetaObject target, IEnumerable<MetaObject> objects)
    {
        var hops = OnTo(target, objects);
        if (hops.Count == 0) return "";
        return $" The reverse hops from {target.Name} are: " +
               string.Join(", ", hops.Select(h => $"\"{h.HopName}\" (walks {h.Hop.Holder.Name}.{h.Hop.Reference.Name} backwards)")) +
               " — a reverse hop is named by the holder's collection name (its @collectionName, else the plural), first letter lowercased.";
    }
}
