// NamingRefs — ADR-0042 package-local object-reference resolution.
//
// Ported 1:1 from typescript/packages/metadata/src/naming-refs.ts
// (resolveObjectRef / refMatchesObject / didYouMeanHint). The SINGLE matcher every
// object-ref site (loader passes AND codegen) shares, so the contract is uniform.

using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>
/// ADR-0042 — resolve a metadata OBJECT reference package-locally.
///   <list type="bullet">
///     <item><b>FQN</b> ref (contains <c>::</c>) → EXACT match on <see cref="MetaData.ResolutionKey"/>.
///       No bare-tail fallback, so an FQN pointing at one package never binds a same-named
///       object in another.</item>
///     <item><b>bare</b> ref (no <c>::</c>) → the referrer's OWN package
///       (<c>&lt;referrerPkg&gt;::&lt;ref&gt;</c>), else a <b>root-level</b> (empty-package) object
///       whose resolution key IS the bare name. No cross-package bare resolution, no
///       globally-unique scan.</item>
///   </list>
/// Mirrors TS <c>naming-refs.ts</c>. There is NO ambiguous outcome (bare = package-local, so
/// ambiguity is unreachable — <c>ERR_AMBIGUOUS_REF</c> is retired).
/// </summary>
public static class NamingRefs
{
    /// <summary>
    /// Does object <paramref name="node"/> satisfy reference <paramref name="reference"/>
    /// declared by a node whose effective package is <paramref name="referrerPkg"/>?
    /// See the type summary for the matcher. <paramref name="referrerPkg"/> defaults to
    /// <c>""</c> — the fail-closed FQN-exact-plus-root-level behavior (never binds a bare ref
    /// across a package boundary), safe for codegen resolvers running on already-validated
    /// FQN metadata.
    /// </summary>
    public static bool RefMatchesObject(MetaData node, string reference, string referrerPkg = "")
    {
        string key = node.ResolutionKey();
        if (reference.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal)) return key == reference;
        if (referrerPkg.Length > 0 && key == $"{referrerPkg}{PACKAGE_SEPARATOR}{reference}") return true;
        return key == reference; // root-level (empty-package) object whose key is the bare name
    }

    /// <summary>
    /// Resolve an OBJECT reference under the ADR-0042 package-local contract (see the type
    /// summary for the matcher). <paramref name="referrerPkg"/> is the effective package of
    /// the node carrying the ref. Returns the resolved object, or null when nothing matches.
    /// Mirrors TS <c>resolveObjectRef(root, ref, referrerPkg).node</c>.
    /// </summary>
    public static MetaData? ResolveObjectRef(MetaData root, string reference, string referrerPkg)
    {
        var objects = root.Children().Where(c => c.Type == TYPE_OBJECT);
        if (reference.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal))
            return objects.FirstOrDefault(c => c.ResolutionKey() == reference);

        // Bare: PREFER the referrer's own package, THEN a root-level (empty-package) object —
        // mirroring the loader symbol table's `byKey.get(localKey) ?? get(ref)` so both
        // resolvers agree when a root-level object shares the bare name.
        string localKey = referrerPkg.Length > 0 ? $"{referrerPkg}{PACKAGE_SEPARATOR}{reference}" : reference;
        var own = objects.FirstOrDefault(c => c.ResolutionKey() == localKey);
        if (own is not null) return own;
        return localKey != reference ? objects.FirstOrDefault(c => c.ResolutionKey() == reference) : null;
    }

    /// <summary>
    /// The effective package of a node = its <see cref="MetaData.ResolutionKey"/> minus the
    /// trailing <c>::&lt;name&gt;</c> (<c>""</c> for a root-level / empty-package node). The
    /// package a bare ref declared on (or under) this node resolves against — mirrors TS
    /// <c>node.package ?? node.fileDefaultPackage ?? ""</c> for a root-level object.
    /// </summary>
    public static string EffectivePackage(MetaData node)
    {
        string key = node.ResolutionKey();
        int i = key.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return i == -1 ? "" : key[..i];
    }

    /// <summary>
    /// ADR-0042 §5 — a did-you-mean suffix for an UNRESOLVED object reference: the FQNs of
    /// same-short-name objects that DO exist (typically in other packages), so the author can
    /// qualify a bare ref they meant to point across a package boundary. Returns <c>""</c> when
    /// no same-short-name object exists. Appended to the per-attr unresolved-ref error message.
    /// Mirrors TS <c>didYouMeanHint</c>.
    /// </summary>
    public static string DidYouMeanHint(MetaData root, string reference)
    {
        // Owner = everything before a dotted child tail (FR-024 `Owner.child`).
        int dot = reference.IndexOf(CHILD_REF_SEPARATOR, StringComparison.Ordinal);
        string owner = dot == -1 ? reference : reference[..dot];
        int sep = owner.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        string shortName = sep == -1 ? owner : owner[(sep + PACKAGE_SEPARATOR.Length)..];
        var candidates = root.Children()
            .Where(c => c.Type == TYPE_OBJECT && c.Name == shortName)
            .Select(c => c.ResolutionKey())
            .ToList();
        if (candidates.Count == 0) return "";
        return $" An object named \"{shortName}\" exists in: {string.Join(", ", candidates)}. " +
               "Qualify it with its package (FQN).";
    }
}
