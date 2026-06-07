// M:N junction FK derivation — the single source of truth for which junction
// columns are the SOURCE side and the TARGET side of a many-to-many relationship.
//
// Ported 1:1 from typescript/packages/metadata/src/core/relationship/derive-m2m-fields.ts.
//
// A M:N relationship (@cardinality: "many", @objectRef: <target>, @through:
// <junction>) does NOT restate its FK columns. They are derived from the junction
// entity's two identity.reference children — one resolving to the source entity,
// one to the target — exactly as 1:N FK direction is declared (find-reference is
// the analogous SSOT).
//
// Three modes (see the FR-017 design):
//   1. Hetero (source != target): the reference resolving to the source entity
//      gives sourceField; the one resolving to the target gives targetField.
//   2. Directed self-join (source == target, @sourceRefField set): both references
//      resolve to the same entity, so @sourceRefField names the source-side FK
//      field; the OTHER reference is the target side.
//   3. Symmetric self-join (source == target, @symmetric: true): undirected; the
//      two references are taken in declaration order (sourceField = first,
//      targetField = second). Resolution unions both at read time.
// Ambiguous (source == target, neither @sourceRefField nor @symmetric) -> throw.

using MetaObjects.Meta;

namespace MetaObjects.Core.Relationship;

/// <summary>Thrown when a M:N relationship's junction FK fields cannot be derived.</summary>
public sealed class M2MDerivationException(string message) : Exception(message)
{
    /// <summary>Cross-port error code (matches the loader validation pass).</summary>
    public string Code => nameof(ErrorCode.ERR_INVALID_RELATIONSHIP);
}

/// <summary>
/// The derived source/target junction FK fields for a M:N relationship.
/// </summary>
/// <param name="SourceField">The junction FK field holding the source-entity key.</param>
/// <param name="TargetField">The junction FK field holding the target-entity key.</param>
public readonly record struct M2MFields(string SourceField, string TargetField);

/// <summary>
/// Derives the source/target junction FK fields for a M:N relationship — the C#
/// analogue of the TS <c>deriveM2MFields</c>.
/// </summary>
public static class M2MDerivation
{
    /// <summary>The first @fields entry of a reference (the physical FK column on the junction).</summary>
    private static string? RefFkField(MetaReferenceIdentity reference)
    {
        var fields = reference.Fields;
        return fields.Count > 0 ? fields[0] : null;
    }

    /// <summary>Last <c>::</c>-segment of a (possibly package-qualified) name.</summary>
    private static string StripPackage(string name)
    {
        int idx = name.LastIndexOf(PACKAGE_SEPARATOR, StringComparison.Ordinal);
        return idx < 0 ? name : name[(idx + PACKAGE_SEPARATOR.Length)..];
    }

    /// <summary>
    /// Derive the source/target junction FK fields for a M:N relationship.
    /// </summary>
    /// <param name="rel">the M:N relationship (carries @objectRef + @through + optional @sourceRefField / @symmetric).</param>
    /// <param name="source">the entity declaring <paramref name="rel"/>.</param>
    /// <param name="root">the loaded model root (to find the junction entity).</param>
    /// <exception cref="M2MDerivationException">
    /// when the junction is missing/malformed or the self-join is ambiguous.
    /// </exception>
    public static M2MFields DeriveM2MFields(MetaRelationship rel, MetaObject source, MetaRoot root)
    {
        string? throughName = rel.Through;
        if (throughName is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{source.Name}.{rel.Name}\" is missing @through (required for M:N derivation)");
        }

        var junction = root.FindObject(throughName);
        if (junction is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{source.Name}.{rel.Name}\" @through \"{throughName}\" does not resolve to an entity");
        }

        string? targetName = rel.ObjectRef;
        if (targetName is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{source.Name}.{rel.Name}\" is missing @objectRef (the M:N target)");
        }

        var refs = junction.ReferenceIdentities();
        if (refs.Count != 2)
        {
            throw new M2MDerivationException(
                $"junction \"{throughName}\" for relationship \"{source.Name}.{rel.Name}\" must declare exactly two " +
                $"identity.reference children (found {refs.Count})");
        }

        bool isSelfJoin = StripPackage(targetName) == source.Name;

        if (!isSelfJoin)
        {
            // Hetero: match each reference by the entity it resolves to.
            var sourceRef = refs.FirstOrDefault(
                r => r.TargetEntity is not null && StripPackage(r.TargetEntity) == source.Name);
            var targetRef = refs.FirstOrDefault(
                r => r.TargetEntity is not null && StripPackage(r.TargetEntity) == StripPackage(targetName));
            var sourceField = sourceRef is not null ? RefFkField(sourceRef) : null;
            var targetField = targetRef is not null ? RefFkField(targetRef) : null;
            if (sourceField is null || targetField is null)
            {
                throw new M2MDerivationException(
                    $"junction \"{throughName}\" for relationship \"{source.Name}.{rel.Name}\" must declare one " +
                    $"identity.reference to \"{source.Name}\" and one to \"{StripPackage(targetName)}\"");
            }
            return new M2MFields(sourceField, targetField);
        }

        // Self-join: both references resolve to the same entity.
        if (rel.Symmetric)
        {
            // Undirected: take references in declaration order; union happens at read time.
            var a = RefFkField(refs[0]);
            var b = RefFkField(refs[1]);
            if (a is null || b is null)
            {
                throw new M2MDerivationException(
                    $"symmetric junction \"{throughName}\" for \"{source.Name}.{rel.Name}\" has a reference with no @fields");
            }
            return new M2MFields(a, b);
        }

        string? sourceRefField = rel.SourceRefField;
        if (sourceRefField is null)
        {
            throw new M2MDerivationException(
                $"self-join relationship \"{source.Name}.{rel.Name}\" through \"{throughName}\" is ambiguous: " +
                "set @sourceRefField (directed) or @symmetric (undirected)");
        }

        // Directed self-join: @sourceRefField names the source-side FK; the other ref is the target.
        var directedSourceRef = refs.FirstOrDefault(r => RefFkField(r) == sourceRefField);
        if (directedSourceRef is null)
        {
            throw new M2MDerivationException(
                $"@sourceRefField \"{sourceRefField}\" on \"{source.Name}.{rel.Name}\" does not match any " +
                $"identity.reference FK field on junction \"{throughName}\"");
        }
        var directedTargetRef = refs.FirstOrDefault(r => !ReferenceEquals(r, directedSourceRef));
        var directedTargetField = directedTargetRef is not null ? RefFkField(directedTargetRef) : null;
        if (directedTargetField is null)
        {
            throw new M2MDerivationException(
                $"junction \"{throughName}\" for \"{source.Name}.{rel.Name}\" has no distinct target-side reference");
        }
        return new M2MFields(sourceRefField, directedTargetField);
    }
}
