// Shared-enum resolution — the ONE authority for "what field.enum declaration does this
// field's vocabulary come from?" (#246 / FR-019). Lives in the core metadata assembly so
// both the loader's #246 validator and every codegen port's enum naming/materialization
// call the SAME predicate and the SAME walk; neither may keep its own copy.
//
// THE RULE. A "shared enum declaration" is a field.enum that is abstract AND a direct
// child of the metadata root. To resolve a field: start at the field itself and walk its
// extends chain; at each node N, in this order:
//   (a) N is a shared enum declaration -> the answer is N (nearest wins: a chained root
//       abstract such as `Money extends Currency` answers Money, not Currency).
//   (b) N declares its OWN @values or its OWN @intValueMap -> the answer is NONE (N starts
//       a new vocabulary; the field keeps its per-object inline enum type).
//   (c) otherwise continue to N's super.
// A non-enum node, the end of the chain, or a cycle answers NONE. There is no condition on
// the hosting object's subtype (entity, projection, value object all qualify) and no hop
// limit.

using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Core.Field;

/// <summary>
/// The single cross-port authority for shared (#246 / FR-019) <c>field.enum</c> resolution.
/// The loader's ERR_ENUM_EXTENDS_VALUES_CONFLICT validator and every codegen port's enum
/// naming/materialization call THIS predicate/walk — never a local re-derivation.
/// </summary>
public static class SharedEnumDeclaration
{
    /// <summary>
    /// True when <paramref name="node"/> is a shared enum DECLARATION: an abstract
    /// <c>field.enum</c> that is a direct child of the metadata root (a package-level
    /// declaration, not one nested under an object). Used both for the #246 validator's
    /// immediate-super check and as the stopping condition inside
    /// <see cref="ResolveSharedEnumDeclaration"/>'s chain walk.
    /// </summary>
    public static bool IsSharedEnumDeclaration(MetaField node) =>
        node.SubType == FIELD_SUBTYPE_ENUM
        && node.IsAbstract
        && node.Parent is { } parent
        && parent.Type == TYPE_METADATA;

    /// <summary>
    /// Resolves <paramref name="field"/> to the shared enum declaration its vocabulary
    /// comes from, or <see langword="null"/> when it has none (an inline enum: no reachable
    /// shared declaration, or a node along the way starts its own vocabulary — see rule (b)
    /// on the type). Walks the <c>extends</c> chain starting at the field itself.
    /// </summary>
    public static MetaField? ResolveSharedEnumDeclaration(MetaField field)
    {
        if (field.SubType != FIELD_SUBTYPE_ENUM) return null;

        var seen = new HashSet<MetaField>(ReferenceEqualityComparer.Instance);
        MetaField? node = field;
        while (node is not null && node.SubType == FIELD_SUBTYPE_ENUM && seen.Add(node))
        {
            if (IsSharedEnumDeclaration(node)) return node;
            // Rule (b): THIS node owning @values or @intValueMap starts a new vocabulary —
            // own-only reads, matching the #246 validator's own-attrs-only content rules.
            if (node.OwnAttr(FIELD_ATTR_VALUES) is not null) return null;
            if (node.OwnAttr(FIELD_ATTR_INT_VALUE_MAP) is not null) return null;
            node = node.ResolveSuper();
        }
        return null;
    }
}
