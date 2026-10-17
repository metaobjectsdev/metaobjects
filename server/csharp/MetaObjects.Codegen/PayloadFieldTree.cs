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
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen;

/// <summary>Derives the <c>Verify.Check</c> field tree from a payload value object.</summary>
public static class PayloadFieldTree
{
    /// <summary>
    /// Derive the verify field tree (the input to <c>Verify.Check</c>) from the object.value a
    /// CANONICAL reference names, resolved exactly (ADR-0059 R7): <c>pkg::Name</c> binds that
    /// package's object, <c>::Name</c> and a bare <c>Name</c> bind the root-level object. No
    /// short-name scan and no package applied; empty when nothing matches exactly. Prefer
    /// <see cref="Build(MetaData)"/> with the target the loader bound
    /// (<c>ValueObjectNames.PayloadShapeOf</c>). <paramref name="referrerPkg"/> is ignored: a
    /// canonical value is absolute.
    /// </summary>
    public static IReadOnlyList<PayloadField> Build(MetaData root, string voName, string referrerPkg = "") =>
        global::MetaObjects.NamingRefs.LookupCanonical(root, voName, TYPE_OBJECT) is { } vo ? Build(vo) : [];

    /// <summary>
    /// The verify field tree of an already-bound payload object. Nested <c>@objectRef</c>s are
    /// read from the targets the loader bound (ADR-0059 R7), never re-resolved by name.
    /// </summary>
    public static IReadOnlyList<PayloadField> Build(MetaData vo) =>
        BuildTree(vo, new HashSet<string>(StringComparer.Ordinal));

    private static IReadOnlyList<PayloadField> BuildTree(MetaData? vo, HashSet<string> visiting)
    {
        // ADR-0039: dedupe/cycle-guard by ResolutionKey (FQN), never the bare ref string — two
        // DIFFERENT same-short-named nodes reached via different bare refs must not collapse
        // onto "already visiting" (the #219-class dedupe defect).
        if (vo is null || !visiting.Add(vo.ResolutionKey())) return [];
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            // ADR-0039: ResolvedIsArray() — the EFFECTIVE (inherited-via-extends) array-ness,
            // never the own flag — is what Verify's positional-accessor rule needs to tell an
            // array-of-scalars (no `-last`) from a single scalar, and an array-of-objects from
            // a single nested object (both carry child Fields; only IsArray disambiguates).
            var isArray = f.ResolvedIsArray();
            if (f.SubType == FIELD_SUBTYPE_OBJECT && f.Attr(FIELD_ATTR_OBJECT_REF) is string)
            {
                var nested = global::MetaObjects.NamingRefs.RefTarget(f, FIELD_ATTR_OBJECT_REF);
                fields.Add(new PayloadField(f.Name, BuildTree(nested, visiting), isArray));
            }
            else
                fields.Add(new PayloadField(f.Name, IsArray: isArray));
        }
        visiting.Remove(vo.ResolutionKey());
        return fields;
    }
}
