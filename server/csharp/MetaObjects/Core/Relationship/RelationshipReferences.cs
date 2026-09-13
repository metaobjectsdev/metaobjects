// Association -> identity.reference resolution (issue #368).
//
// An entity may declare more than one identity.reference onto the SAME target
// entity (Match.homeTeamRef and Match.awayTeamRef both -> Team). A
// `@cardinality: one` relationship names only its target, so when two
// references match, the target alone cannot say which FK the navigation uses.
// Taking the first match emits a join on the wrong column that typechecks, has
// correct DDL and passes verify — so the ladder below resolves it explicitly or
// not at all. ADR-0029 §5: ambiguity is a load error naming the candidates.
//
// Ported 1:1 from
// typescript/packages/metadata/src/core/relationship/resolve-relationship-reference.ts
// (see also the Python port, relationship_references.py) — that file is the
// authoritative spec; this module mirrors it exactly (same suffix list, same
// order, same "candidate side only" stripping).

using MetaObjects.Meta;

namespace MetaObjects.Core.Relationship;

/// <summary>
/// Which identity.reference does a <c>@cardinality: one</c> relationship
/// navigate through, when its target entity carries more than one
/// identity.reference candidate onto the same target? See
/// <see cref="ResolveRelationshipReference"/> for the four-step ladder.
/// </summary>
public static class RelationshipReferences
{
    /// <summary>
    /// Trailing suffixes stripped from a CANDIDATE's name/FK field when building its
    /// pairing keys. Ordered — first match wins, so "reference" is tested before
    /// "ref". Never applied to the relationship name (see ReferencePairingKeys).
    /// </summary>
    private static readonly string[] PairingSuffixes = ["reference", "ref", "id", "key"];

    private static string StripOneSuffix(string value)
    {
        foreach (var suffix in PairingSuffixes)
        {
            if (value.Length > suffix.Length && value.EndsWith(suffix, StringComparison.Ordinal))
            {
                return value[..^suffix.Length];
            }
        }
        return value;
    }

    /// <summary>The FK field a reference is anchored on (first field; composite FKs pair on their first column).</summary>
    private static string? RefFkField(MetaReferenceIdentity reference)
    {
        var fields = reference.Fields;
        return fields.Count > 0 ? fields[0] : null;
    }

    /// <summary>Last <c>::</c>-segment of a (possibly package-qualified, possibly null/empty) name.</summary>
    private static string StripPackage(string? name)
    {
        if (string.IsNullOrEmpty(name)) return "";
        int idx = name.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return idx < 0 ? name : name[(idx + PACKAGE_SEPARATOR.Length)..];
    }

    /// <summary>
    /// The set of lowercased names a candidate reference answers to: its own
    /// name and its FK field, each with and without one stripped suffix.
    /// Ordinal, culture-invariant lowercasing — behaviour must not vary by locale.
    /// </summary>
    public static HashSet<string> ReferencePairingKeys(MetaReferenceIdentity reference)
    {
        var keys = new HashSet<string>();
        void Add(string? value)
        {
            if (string.IsNullOrEmpty(value)) return;
            string lower = value.ToLowerInvariant();
            keys.Add(lower);
            keys.Add(StripOneSuffix(lower));
        }
        Add(reference.Name);
        Add(RefFkField(reference));
        return keys;
    }

    /// <summary>
    /// Every identity.reference on <paramref name="holder"/> whose @references targets
    /// <paramref name="targetEntity"/>. Package-insensitive on both sides: @references
    /// and @objectRef may each be bare or fully qualified.
    /// </summary>
    public static List<MetaReferenceIdentity> ReferenceCandidatesFor(MetaObject holder, string targetEntity)
    {
        string target = StripPackage(targetEntity);
        // ADR-0039: resolving — ReferenceIdentities() honors references inherited via extends.
        return holder.ReferenceIdentities()
            .Where(r => StripPackage(r.TargetEntity) == target)
            .Where(r => RefFkField(r) is not null)
            .ToList();
    }

    /// <summary>
    /// Which identity.reference does this <c>@cardinality: one</c> relationship
    /// navigate through? The ladder, in order:
    /// <list type="number">
    ///   <item>exactly one candidate -> that one (the common case; unchanged behaviour)</item>
    ///   <item><c>@sourceRefField</c> declared -> the candidate whose FK field it names,
    ///     SHORT-CIRCUITING (does not fall through to name-pairing on a miss)</item>
    ///   <item>exactly one candidate name-pairs -> that one</item>
    ///   <item>otherwise -> null (caller reports the ambiguity)</item>
    /// </list>
    /// Returns null for "no candidate" and "cannot choose" alike; callers that need to
    /// tell them apart use <see cref="ReferenceCandidatesFor"/>.
    /// </summary>
    public static MetaReferenceIdentity? ResolveRelationshipReference(
        MetaObject holder, string relationshipName, string targetEntity, string? sourceRefField = null)
    {
        var candidates = ReferenceCandidatesFor(holder, targetEntity);
        if (candidates.Count == 0) return null;
        if (candidates.Count == 1) return candidates[0];

        if (!string.IsNullOrEmpty(sourceRefField))
        {
            return candidates.FirstOrDefault(r => RefFkField(r) == sourceRefField);
        }

        string wanted = relationshipName.ToLowerInvariant();
        var paired = candidates.Where(r => ReferencePairingKeys(r).Contains(wanted)).ToList();
        return paired.Count == 1 ? paired[0] : null;
    }
}
