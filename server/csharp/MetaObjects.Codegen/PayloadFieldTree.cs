// The metadata→verify bridge for prompt construction (FR-004): derive the field tree
// `Verify.Check` drift-checks a template body against, from the template's @payloadRef
// value object.
//
// This file used to be PayloadCodegen, which also emitted a payload record per template.
// ADR-0056 removed that second type family — the value object's own POCO (EntityGenerator)
// is the payload type — so only the field-tree bridge remains.

using MetaObjects.Meta;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen;

/// <summary>Derives the <c>Verify.Check</c> field tree from a payload value object.</summary>
public static class PayloadFieldTree
{
    /// <summary>
    /// Resolve a payload object reference: FQN-exact when qualified (ADR-0041/0042); package-local
    /// when bare (the referrer's own package, else root-level) — falling back to a GLOBAL short-name
    /// scan when the package-local match fails, so an implicit-package top-level name (no
    /// <paramref name="referrerPkg"/> supplied) still resolves. A fully-qualified ref never reaches
    /// the fallback, and ADR-0042 already makes the loader reject a bare ref meant to cross a
    /// package boundary.
    /// </summary>
    private static MetaData? Resolve(MetaData root, string reference, string referrerPkg)
    {
        var resolved = global::MetaObjects.NamingRefs.ResolveObjectRef(root, reference, referrerPkg);
        if (resolved is not null) return resolved;
        if (reference.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal)) return null; // FQN already resolved exactly above
        return root.Children().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == reference);
    }

    /// <summary>
    /// Derive the verify field tree (the input to <c>Verify.Check</c>) from an object.value
    /// view-object: scalars become leaves, object-ref fields recurse into nested element trees.
    /// This is the bridge a `dotnet meta verify` command uses to drift-check a template against
    /// its @payloadRef. <paramref name="referrerPkg"/> (ADR-0042, #228) is the declaring
    /// template's effective package — a bare <paramref name="voName"/> resolves there FIRST, so a
    /// template whose bare <c>@payloadRef</c> collides with a same-short-named object.value in
    /// ANOTHER package binds its OWN package's object — never whichever one loads first.
    /// </summary>
    public static IReadOnlyList<PayloadField> Build(MetaData root, string voName, string referrerPkg = "") =>
        BuildTree(root, voName, referrerPkg, new HashSet<string>(StringComparer.Ordinal));

    private static IReadOnlyList<PayloadField> BuildTree(MetaData root, string voName, string referrerPkg, HashSet<string> visiting)
    {
        var vo = Resolve(root, voName, referrerPkg);
        // ADR-0039: dedupe/cycle-guard by ResolutionKey (FQN), never the bare ref string — two
        // DIFFERENT same-short-named nodes reached via different bare refs must not collapse
        // onto "already visiting" (the #219-class dedupe defect).
        if (vo is null || !visiting.Add(vo.ResolutionKey())) return [];
        var voPkg = global::MetaObjects.NamingRefs.EffectivePackage(vo);
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            // ADR-0039: resolving — @objectRef may be inherited via extends (TS reads f.attr).
            if (f.SubType == FIELD_SUBTYPE_OBJECT && f.Attr(FIELD_ATTR_OBJECT_REF) is string refName)
            {
                // ADR-0042: a nested @objectRef resolves in the FIELD's OWN declaring package,
                // which may differ from this VO's when the field is inherited via extends from
                // an abstract VO in another package.
                var fieldPkg = f.Parent is not null
                    ? global::MetaObjects.NamingRefs.EffectivePackage(f.Parent)
                    : voPkg;
                fields.Add(new PayloadField(f.Name, BuildTree(root, refName, fieldPkg, visiting)));
            }
            else
                fields.Add(new PayloadField(f.Name));
        }
        visiting.Remove(vo.ResolutionKey());
        return fields;
    }
}
