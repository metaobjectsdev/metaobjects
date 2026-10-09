// RequirementClaims — resolve an `@implementedBy` reference to the node it names.
//
// Ported 1:1 from
//   server/typescript/packages/metadata/src/core/requirement/resolve-claim.ts
// plus `splitMemberRef` from the TypeScript gate (cli/src/lib/requirement-check.ts).
//
// ONE resolver, shared by the requirement gate (RequirementCheck) and the
// requirement-test generator, so the ADR-0042 package-local binding contract has a
// single owner and a second name scan never forks it.

using MetaObjects.Meta;

namespace MetaObjects.Core.Requirement;

/// <summary>Resolves requirement claims (<c>@implementedBy</c> references) against the loaded model.</summary>
public static class RequirementClaims
{
    /// <summary>A reference split into its owning root-level node and the dotted member path under it.</summary>
    public sealed record MemberRef(string Owner, IReadOnlyList<string> Path);

    /// <summary>
    /// Split a member reference into its owning ref and the dotted member path. <c>::</c>
    /// qualifies the ROOT-level node only, so the owner ends at the first <c>.</c> after
    /// the last <c>::</c>: <c>acme::sales::Order.total.display</c> gives owner
    /// <c>acme::sales::Order</c> and path <c>[total, display]</c>.
    /// </summary>
    public static MemberRef SplitMemberRef(string reference)
    {
        int pkgEnd = reference.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        int from = pkgEnd == -1 ? 0 : pkgEnd + PACKAGE_SEPARATOR.Length;
        int dot = reference.IndexOf(CHILD_REF_SEPARATOR, from, StringComparison.Ordinal);
        if (dot == -1) return new MemberRef(reference, []);
        return new MemberRef(
            reference[..dot],
            reference[(dot + CHILD_REF_SEPARATOR.Length)..].Split(CHILD_REF_SEPARATOR));
    }

    /// <summary>
    /// Resolve the owner segment of an <c>@implementedBy</c> reference to the node it names.
    ///
    /// <para>OBJECTS FIRST, through the loader's own resolver
    /// (<see cref="NamingRefs.ResolveObjectRef"/>), so package-local binding stays the ADR-0042
    /// contract and never a parallel name scan (#228). Then ROOT-LEVEL NON-OBJECT nodes: a
    /// <c>template.prompt</c> and its siblings. Requirements are excluded: hierarchy is nesting,
    /// and a requirement claiming a requirement would be a second, contradictory parent
    /// mechanism.</para>
    /// </summary>
    /// <param name="referrerPkg">The effective package of the requirement making the claim.</param>
    /// <returns>The node, or null when nothing matches or the match is ambiguous.</returns>
    public static MetaData? ResolveClaimTarget(MetaData root, string owner, string referrerPkg)
    {
        var obj = NamingRefs.ResolveObjectRef(root, owner, referrerPkg);
        if (obj is not null) return obj;

        var candidates = root.Children()
            .Where(c => c.Type != TYPE_OBJECT && c.Type != TYPE_REQUIREMENT)
            .ToList();

        // A fully-qualified reference binds exactly, like every other FQN in the model.
        if (owner.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal))
            return candidates.FirstOrDefault(c => c.ResolutionKey() == owner);

        // A bare reference prefers the referrer's own package, then a root-level node of that
        // bare name. An ambiguous bare name binds NOTHING: the same fail-closed rule objects use.
        if (referrerPkg.Length > 0)
        {
            var localKey = $"{referrerPkg}{PACKAGE_SEPARATOR}{owner}";
            var local = candidates.Where(c => c.ResolutionKey() == localKey).ToList();
            if (local.Count == 1) return local[0];
        }
        // Root-level (unpackaged) only, matching ResolveObjectRef's own bare fallback.
        var bare = candidates.Where(c => c.Name == owner && c.ResolutionKey() == owner).ToList();
        return bare.Count == 1 ? bare[0] : null;
    }

    /// <summary>
    /// Walk dotted member segments by CHILD NAME from a node, to full depth. Exposed beside
    /// <see cref="ResolveClaimTarget"/> because the gate's coverage pass needs the OWNER node's
    /// key while using member resolution only as a yes/no validity test.
    /// </summary>
    public static MetaData? ResolveMember(MetaData obj, IReadOnlyList<string> path)
    {
        MetaData? cur = obj;
        foreach (var seg in path)
        {
            if (cur is null) return null;
            cur = cur.Children().FirstOrDefault(c => c.Name == seg);
        }
        return cur;
    }

    /// <summary>
    /// Resolve a full <c>@implementedBy</c> reference, owner plus any dotted member segments, to
    /// the node it names, or null. Resolution walks to the FULL depth of the reference, so
    /// <c>Council.slug.display</c> yields the view node rather than stopping at the field.
    /// </summary>
    public static MetaData? ResolveClaim(MetaData root, string reference, string referrerPkg)
    {
        // Segments split on every dot, as the reference does: a package qualifies the root
        // node only and carries no dot, so the first segment is the whole owner.
        var segs = reference.Split(CHILD_REF_SEPARATOR);
        var owner = ResolveClaimTarget(root, segs[0], referrerPkg);
        if (owner is null || segs.Length == 1) return owner;
        return ResolveMember(owner, segs[1..]);
    }
}
