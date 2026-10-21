// ADR-0059 R5 — resolve every reference once, after validation and before freeze.
//
// Sources do not interpret references (R1): YAML and canonical JSON hand the loader each
// reference string exactly as written. The validation passes resolve those authored strings
// through the shared resolver and report failures with their own codes. This pass then walks
// the physical tree once and, for every reference that resolves, records the target and
// rewrites the value to its canonical spelling (R6), keeping the authored string beside it.
// A reference that does not resolve is left exactly as written: validation already reported it.
//
// Mirrors typescript/packages/metadata/src/loader/resolve-references.ts.

using MetaObjects.Meta;

namespace MetaObjects.Loader;

internal static class ResolveReferences
{
    /// <summary>
    /// Resolve every own reference attribute (ADR-0059 R4) and every <c>extends</c> in the tree,
    /// record the targets, and rewrite resolved values to their canonical spelling. Must run after
    /// the last validation pass and before <c>Freeze()</c>.
    /// </summary>
    public static void Run(MetaData root) => Visit(root, root);

    private static void Visit(MetaData root, MetaData node)
    {
        if (!ReferenceEquals(node, root))
        {
            ResolveExtends(root, node);
            // R3 default: the effective package of the top-level node that physically declares
            // the attribute. Own attributes are declared here, by definition.
            string declPkg = NamingRefs.EffectivePackageOf(NamingRefs.TopLevelNodeOf(node));
            // ADR-0039: own — this pass rewrites the declared-here layer; an inherited attribute
            // is resolved once, on the node that declares it.
            foreach (string name in node.OwnAttrs().Keys.ToList())
            {
                if (NamingRefs.RefBearingAttrNames.Contains(name)) ResolveAttr(root, node, name, declPkg);
            }
        }
        // ADR-0039: own — structural walk over the physical declaration tree.
        foreach (var child in node.OwnChildren()) Visit(root, child);
    }

    private sealed record Resolved(MetaData Target, string Canonical);

    /// <summary>Resolve one reference string's owner in <paramref name="refPkg"/> and spell it canonically.</summary>
    private static Resolved? ResolveOne(MetaData root, string value, string refPkg, string declPkg)
    {
        var (owner, tail) = NamingRefs.SplitChildTail(value);
        var target = NamingRefs.ResolveObjectRef(root, owner, refPkg);
        if (target is null) return null;
        return new Resolved(target, NamingRefs.SpellRef(target, refPkg.Length > 0 ? refPkg : declPkg, tail));
    }

    /// <summary>R3 — the package an own reference attribute of <paramref name="node"/> resolves in.</summary>
    private static string ReferrerPackage(MetaData root, MetaData node, string attr, string declPkg)
    {
        // `@of` on a dimension that walks `@via`: the package of the entity the walk reaches.
        if (node.Type == TYPE_DIMENSION && attr == REPORTING_ATTR_OF)
        {
            // ADR-0039: resolving — the @via that governs this @of may be inherited.
            if (node.Attr(REPORTING_ATTR_VIA) is string via && via.Length > 0 && node.Parent is { } declaring)
            {
                var terminal = ValidationPasses.DimensionViaTerminal(root, declaring, via);
                return terminal is not null ? NamingRefs.EffectivePackageOf(terminal) : declPkg;
            }
        }
        // `@spine` on a report: the package of the `@from` entity.
        if (node.Type == TYPE_OBJECT && node.SubType == OBJECT_SUBTYPE_REPORT && attr == OBJECT_REPORT_ATTR_SPINE)
        {
            // ADR-0039: resolving — @from may be inherited.
            if (node.Attr(OBJECT_REPORT_ATTR_FROM) is string from && from.Length > 0)
            {
                var fromNode = NamingRefs.ResolveObjectRef(root, from, declPkg);
                if (fromNode is not null) return NamingRefs.EffectivePackageOf(fromNode);
            }
        }
        return declPkg;
    }

    private static void ResolveAttr(MetaData root, MetaData node, string attr, string declPkg)
    {
        object? value = node.OwnAttr(attr);
        string refPkg = ReferrerPackage(root, node, attr, declPkg);
        if (value is string s)
        {
            if (s.Length == 0) return;
            var r = ResolveOne(root, s, refPkg, declPkg);
            if (r is null) return;
            node.SetResolvedTarget(attr, r.Target);
            if (r.Canonical != s) node.SetCanonicalAttr(attr, r.Canonical);
            return;
        }
        if (value is IReadOnlyList<string> items)
        {
            var resolved = items.Select(v => v.Length == 0 ? null : ResolveOne(root, v, refPkg, declPkg)).ToList();
            if (resolved.All(r => r is null)) return;
            node.SetResolvedTarget(attr, resolved.Select(r => r?.Target).ToList());
            var canonical = items.Select((v, i) => resolved[i]?.Canonical ?? v).ToList();
            if (!canonical.SequenceEqual(items)) node.SetCanonicalAttr(attr, canonical);
        }
    }

    /// <summary>Canonical <c>extends</c>: the owner spelled from the declaring node's package, tail kept.</summary>
    private static void ResolveExtends(MetaData root, MetaData node)
    {
        string? reference = node.SuperRef;
        if (reference is null || node.SuperData is null) return;
        string pkg = NamingRefs.EffectivePackageOf(node);
        var (owner, tail) = NamingRefs.SplitChildTail(reference);
        MetaData? ownerNode;
        try { ownerNode = SuperResolve.ResolveSuperRef(owner, pkg, root); }
        catch (RefOverDropException) { return; } // an over-drop never resolved, so SuperData would be unset
        if (ownerNode is null) return;
        string canonical = NamingRefs.SpellRef(ownerNode, pkg, tail);
        if (canonical == reference) return;
        node.SetCanonicalSuper(canonical);
    }
}
