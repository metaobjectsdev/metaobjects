// NamingRefs — the one reference resolver every reference form goes through (ADR-0059).
//
// Sources do not interpret references: YAML, canonical JSON and any later source build
// the tree with every reference string exactly as authored. This module gives each form
// its meaning, once, against the built tree:
//
//   `::Rest`     root-absolute — the node whose resolution key is exactly `Rest`.
//   `..::Rest`   parent-relative — drop one segment of the referrer's package per `..::`,
//                then the exact key `<remaining>::Rest`. More `..::` than the package has
//                segments is ERR_BAD_ATTR_VALUE.
//   `pkg::Name`  exact.
//   `Name`       the referrer's own package (`<referrerPkg>::Name`), else the root-level
//                `Name` (ADR-0042 §2). Never another package.
//
// No form falls back to another and none matches on a short name. A FR-024 dotted child
// tail (`Owner.child.grand`) starts at the first `.` after the last `::`; only the owner is
// resolved by form. `SpellRef` is the inverse: the one canonical spelling of a resolved
// target, which the loader's `ResolveReferences` pass writes back.
//
// Mirrors typescript/packages/metadata/src/naming-refs.ts.

using MetaObjects.Meta;

namespace MetaObjects;

/// <summary>A parent-relative reference with more <c>..::</c> than its referrer's package has segments.</summary>
public sealed class RefOverDropException(string message) : Exception(message);

/// <summary>
/// ADR-0059 R2 — resolve metadata references. See the file header for the forms.
/// </summary>
public static class NamingRefs
{
    private const string ParentPrefix = PACKAGE_PARENT + PACKAGE_SEPARATOR; // "..::"

    /// <summary>
    /// The inline attribute names whose VALUE is a metadata object reference (ADR-0059 R4).
    /// The structural <c>extends</c> key is handled separately. <c>@sourceRefField</c> (a FK
    /// field name) and <c>@implementedBy</c> (which may name a member) are NOT in the set.
    /// </summary>
    public static readonly IReadOnlySet<string> RefBearingAttrNames = new HashSet<string>(StringComparer.Ordinal)
    {
        RELATIONSHIP_ATTR_OBJECT_REF, FIELD_ATTR_OBJECT_REF, RELATIONSHIP_ATTR_THROUGH,
        IDENTITY_REFERENCE_ATTR_REFERENCES,
        ORIGIN_PASSTHROUGH_ATTR_FROM, ORIGIN_PASSTHROUGH_ATTR_VIA,
        ORIGIN_AGGREGATE_ATTR_OF, ORIGIN_AGGREGATE_ATTR_VIA,
        SOURCE_ATTR_PARAMETER_REF, TEMPLATE_ATTR_PAYLOAD_REF, TEMPLATE_ATTR_RESPONSE_REF,
        OBJECT_REPORT_ATTR_FROM, OBJECT_REPORT_ATTR_SPINE,
    };

    /// <summary>
    /// Split a ref into its owner part and any FR-024 dotted child tail. The <c>.</c> that marks
    /// a child can only appear in the FINAL <c>::</c>-segment, so the owner ends at the first
    /// <c>.</c> AFTER the last <c>::</c>. <c>Tail</c> includes the leading <c>.</c> ("" when none).
    /// </summary>
    public static (string Owner, string Tail) SplitChildTail(string raw)
    {
        int lastSep = raw.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        int segStart = lastSep == -1 ? 0 : lastSep + PACKAGE_SEPARATOR.Length;
        int dot = raw.IndexOf(CHILD_REF_SEPARATOR, segStart, StringComparison.Ordinal);
        return dot == -1 ? (raw, "") : (raw[..dot], raw[dot..]);
    }

    /// <summary>Expand the two relative forms against a package; throws on over-drop.</summary>
    private static string ExpandOwner(string owner, string packageContext)
    {
        if (owner.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal))
            return owner[PACKAGE_SEPARATOR.Length..];

        if (owner.StartsWith(ParentPrefix, StringComparison.Ordinal))
        {
            string rest = owner;
            int levels = 0;
            while (rest.StartsWith(ParentPrefix, StringComparison.Ordinal))
            {
                levels++;
                rest = rest[ParentPrefix.Length..];
            }
            string[] pkgParts = packageContext.Length == 0
                ? []
                : packageContext.Split(PACKAGE_SEPARATOR, StringSplitOptions.None);
            if (levels > pkgParts.Length)
            {
                throw new RefOverDropException(
                    $"Relative reference '{owner}' over-drops: {levels} parent level(s) " +
                    $"but the package context '{packageContext}' has only {pkgParts.Length} segment(s)");
            }
            string reduced = string.Join(PACKAGE_SEPARATOR, pkgParts[..(pkgParts.Length - levels)]);
            return reduced.Length != 0 ? reduced + PACKAGE_SEPARATOR + rest : rest;
        }

        if (owner.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal)) return owner;
        return packageContext.Length != 0 ? packageContext + PACKAGE_SEPARATOR + owner : owner;
    }

    /// <summary>
    /// The resolution keys an OWNER reference (no child tail) may bind, in the order to try them
    /// (ADR-0059 R2). Every form but bare is one exact key; bare is the referrer's own package,
    /// then root-level. Throws <see cref="RefOverDropException"/> on over-drop.
    /// </summary>
    public static IReadOnlyList<string> OwnerCandidateKeys(string owner, string referrerPkg)
    {
        if (owner.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal))
            return [owner[PACKAGE_SEPARATOR.Length..]];
        if (owner.StartsWith(ParentPrefix, StringComparison.Ordinal))
            return [ExpandOwner(owner, referrerPkg)];
        if (owner.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal)) return [owner];
        return referrerPkg.Length > 0 ? [$"{referrerPkg}{PACKAGE_SEPARATOR}{owner}", owner] : [owner];
    }

    /// <summary>
    /// Does object <paramref name="node"/> satisfy reference <paramref name="reference"/> (no child
    /// tail) declared by a node whose package is <paramref name="referrerPkg"/>? Agrees with
    /// <see cref="ResolveObjectRef"/>; never matches on a short name.
    /// </summary>
    public static bool RefMatchesObject(MetaData node, string reference, string referrerPkg = "")
    {
        MetaData? resolved = ResolveObjectRef(node.Root(), reference, referrerPkg);
        return resolved is not null && ReferenceEquals(resolved, node);
    }

    private static MetaData? BindOwner(IEnumerable<MetaData> candidates, string owner, string referrerPkg)
    {
        IReadOnlyList<string> keys;
        try { keys = OwnerCandidateKeys(owner, referrerPkg); }
        catch (RefOverDropException) { return null; }
        var list = candidates as IReadOnlyList<MetaData> ?? candidates.ToList();
        foreach (string key in keys)
        {
            foreach (var c in list)
                if (c.ResolutionKey() == key) return c;
        }
        return null;
    }

    private static IEnumerable<MetaData> TopLevelOfType(MetaData root, string? type) =>
        type is null ? root.Children() : root.Children().Where(c => c.Type == type);

    /// <summary>
    /// Resolve a metadata OBJECT reference (no child tail) under ADR-0059 R2.
    /// <paramref name="referrerPkg"/> is the referrer's package (R3). Returns the object, or null
    /// when nothing matches (an over-dropping <c>..::</c> also yields null; see
    /// <see cref="OwnerCandidateKeys"/> to tell the two apart). The single object resolver.
    /// </summary>
    public static MetaData? ResolveObjectRef(MetaData root, string reference, string referrerPkg) =>
        BindOwner(TopLevelOfType(root, TYPE_OBJECT), reference, referrerPkg);

    /// <summary>
    /// Resolve a reference that may carry a dotted child tail: bind the owner among the root's
    /// top-level nodes (of <paramref name="ownerType"/> when given), then walk the tail by child
    /// name. Intermediate segments must be unique among the current node's effective children;
    /// the last is scoped to <paramref name="lastType"/> when given.
    /// </summary>
    public static (MetaData? Node, MetaData? Owner) ResolveRef(
        MetaData root, string reference, string referrerPkg, string? ownerType = null, string? lastType = null)
    {
        var (owner, tail) = SplitChildTail(reference);
        MetaData? bound = BindOwner(TopLevelOfType(root, ownerType), owner, referrerPkg);
        if (bound is null) return (null, null);
        if (tail.Length == 0) return (bound, bound);
        string[] path = tail[CHILD_REF_SEPARATOR.Length..].Split(CHILD_REF_SEPARATOR);
        if (path.Any(p => p.Length == 0)) return (null, null);
        MetaData current = bound;
        for (int i = 0; i < path.Length - 1; i++)
        {
            var matches = current.Children().Where(c => c.Name == path[i]).ToList();
            if (matches.Count != 1) return (null, bound);
            current = matches[0];
        }
        string last = path[^1];
        var target = current.Children().FirstOrDefault(c => c.Name == last && (lastType is null || c.Type == lastType));
        return (target, bound);
    }

    /// <summary>
    /// ADR-0059 R7 — resolve a CANONICAL reference with no referrer: strip one leading <c>::</c>,
    /// match a top-level node's resolution key exactly, then walk any dotted tail. Never matches
    /// on a short name.
    /// </summary>
    public static MetaData? LookupCanonical(MetaData root, string value, string? ownerType = null, string? lastType = null)
    {
        var (owner, tail) = SplitChildTail(value);
        string exact = owner.StartsWith(PACKAGE_SEPARATOR, StringComparison.Ordinal) ? owner : PACKAGE_SEPARATOR + owner;
        return ResolveRef(root, exact + tail, "", ownerType, lastType).Node;
    }

    /// <summary>
    /// ADR-0059 R6 — the canonical spelling of a resolved owner as written from a referrer in
    /// package <paramref name="referrerPkg"/>: <c>pkg::Name</c> for a packaged target, <c>::Name</c>
    /// for a root-level target from a packaged referrer, <c>Name</c> from a root-level referrer.
    /// </summary>
    public static string SpellRef(MetaData target, string referrerPkg, string tail = "")
    {
        string key = target.ResolutionKey();
        bool rootLevel = !key.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return (rootLevel && referrerPkg.Length > 0 ? PACKAGE_SEPARATOR + key : key) + tail;
    }

    /// <summary>Effective package of a node: its own <c>package</c>, else its file's (ADR-0059 R10).</summary>
    public static string EffectivePackageOf(MetaData node) => node.Package ?? node.FileDefaultPackage ?? "";

    /// <summary>The top-level node (a direct child of the root) that physically contains <paramref name="node"/>.</summary>
    public static MetaData TopLevelNodeOf(MetaData node)
    {
        MetaData current = node;
        while (current.Parent is not null && current.Parent.Parent is not null) current = current.Parent;
        return current;
    }

    /// <summary>
    /// ADR-0059 R3 default — the package a reference attribute resolves in: the effective package
    /// of the top-level node that PHYSICALLY declares the attribute (walks the super chain to the
    /// layer that owns it), so an inherited reference means what it meant where it was written.
    /// </summary>
    public static string ReferrerPackageFor(MetaData node, string attrName)
    {
        MetaData? declarer = node;
        var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        // ADR-0039: own — locating the layer that physically declares the attr.
        while (declarer is not null && !declarer.OwnHasAttr(attrName) && seen.Add(declarer))
            declarer = declarer.SuperData;
        return EffectivePackageOf(TopLevelNodeOf(declarer ?? node));
    }

    /// <summary>
    /// ADR-0059 R7 — the object a reference attribute on <paramref name="node"/> names: the owner
    /// the loader bound once, read RESOLVING so an inherited attribute works (ADR-0039). A tree
    /// built without the loader has no recorded target, so the value is resolved here from the
    /// package of the node that declared it. Null when the attribute is absent, a list, or names
    /// nothing.
    /// </summary>
    public static MetaData? RefTarget(MetaData node, string attrName)
    {
        var seen = new HashSet<MetaData>(ReferenceEqualityComparer.Instance);
        for (MetaData? n = node; n is not null && seen.Add(n); n = n.SuperData)
        {
            // ADR-0039: own — locating the layer that declares the attr, walking the super chain.
            if (!n.OwnHasAttr(attrName)) continue;
            if (n.ResolvedTargetOf(attrName) is { } recorded) return recorded;
            if (n.OwnAttr(attrName) is not string value || value.Length == 0) return null;
            var (owner, _) = SplitChildTail(value);
            return ResolveObjectRef(node.Root(), owner, EffectivePackageOf(TopLevelNodeOf(n)));
        }
        return null;
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
        var found = SameNamedObjects(root, reference);
        if (found is null) return "";
        return $" An object named \"{found.Value.ShortName}\" exists in: {string.Join(", ", found.Value.Candidates)}. " +
               "Qualify it with its package (FQN).";
    }

    /// <summary>
    /// The did-you-mean suffix for an UNRESOLVED <c>extends</c> ref: the same candidates as
    /// <see cref="DidYouMeanHint"/> plus the exact spelling to write, because a bare <c>extends</c>
    /// resolves in the referrer's own package. Mirrors TS <c>didYouMeanSuperHint</c>.
    /// </summary>
    public static string DidYouMeanSuperHint(MetaData root, string reference)
    {
        var found = SameNamedObjects(root, reference);
        if (found is null) return "";
        return $" An object named \"{found.Value.ShortName}\" exists in: {string.Join(", ", found.Value.Candidates)}. " +
               $"Qualify it with its package (FQN): write extends: \"{found.Value.Candidates[0]}\".";
    }

    private static (string ShortName, List<string> Candidates)? SameNamedObjects(MetaData root, string reference)
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
        return candidates.Count == 0 ? null : (shortName, candidates);
    }
}
