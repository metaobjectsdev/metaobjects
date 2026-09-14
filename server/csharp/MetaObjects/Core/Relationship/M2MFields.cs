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
//
// "source" above means the relationship's SUBJECT, and under `extends` there are two
// legitimate names for it. Every caller walks the RESOLVING Relationships()
// (M2MNavigationBuilder for codegen, M2MResolver at run time) and passes the entity it
// is ITERATING, which for an inherited relationship is not the one that declared it.
// So the DECLARING entity is resolved here from rel.Parent (same shape as the #368
// loader fix, ValidationPasses' `declaringEntity = rel.Parent ?? obj`), and the passed
// `source` is kept alongside it rather than discarded: a junction FK usually references
// the CONCRETE entity, because the abstract base has no table, while @objectRef on an
// inherited self-join names the base. Both are accepted, for the self-join
// classification and the hetero reference match alike. Not covered: a junction
// reference naming an entity strictly BETWEEN the base and the navigating entity in a
// deeper hierarchy.
//
// The subject comparison is made on RESOLVED OBJECT IDENTITY, not on stripped short
// names, matching the Java reference (M2MFields.java). Bare-name equality cannot tell
// `a::NodeBase` from `b::NodeBase`, so once the subject set held two names a genuine
// CROSS-PACKAGE hetero M:N whose target shares a short name with the subject read as a
// self-join and refused to derive. Scoped deliberately to this one predicate — every
// other name comparison in this file is untouched.

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
    /// The root entity a reference name denotes, or <c>null</c>. Mirrors the Java
    /// reference's <c>M2MFields.findObject</c> exactly: a FULLY-QUALIFIED name (one
    /// containing <c>::</c>) resolves EXACTLY on the object's package-folded key, never
    /// a bare-tail fallback; a bare name matches a short name, first match wins (the
    /// bare-collision case is the deferred follow-up Java records as issue #174).
    ///
    /// This exists so the SUBJECT comparison can be made on object IDENTITY the way
    /// Java's already is. A bare-name compare cannot tell <c>a::NodeBase</c> from
    /// <c>b::NodeBase</c>, which made a genuine cross-package hetero M:N read as a
    /// self-join the moment the subject set held two names.
    /// </summary>
    /// <summary>
    /// Public so codegen descriptors can resolve an entity reference by the SAME rule
    /// the derivation uses. <c>M2MNavigation.IsSelfJoin</c> compares the descriptor's
    /// target against its source by identity; if the builder resolved the target by a
    /// package-stripped name while the derivation resolved it exactly, the two could
    /// disagree about whether a relationship is a self-join — and the EF wiring follows
    /// the descriptor. Additive: no existing resolution changed.
    /// </summary>
    public static MetaObject? ResolveEntity(MetaRoot root, string? name) => FindEntity(root, name);

    private static MetaObject? FindEntity(MetaRoot root, string? name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        var objects = root.Objects();
        if (name.Contains(PACKAGE_SEPARATOR, StringComparison.Ordinal))
            return objects.FirstOrDefault(o => string.Equals(o.ResolutionKey(), name, StringComparison.Ordinal));
        var bare = StripPackage(name);
        return objects.FirstOrDefault(o => string.Equals(o.Name, bare, StringComparison.Ordinal));
    }

    /// <summary>
    /// Derive the source/target junction FK fields for a M:N relationship.
    /// </summary>
    /// <param name="rel">the M:N relationship (carries @objectRef + @through + optional @sourceRefField / @symmetric).</param>
    /// <param name="source">the entity the caller is navigating from. Accepted alongside
    /// <c>rel.Parent</c> as a name for the relationship's subject, and used as the
    /// declaring entity when <paramref name="rel"/> has no <see cref="MetaObject"/> parent.</param>
    /// <param name="root">the loaded model root (to find the junction entity).</param>
    /// <exception cref="M2MDerivationException">
    /// when the junction is missing/malformed or the self-join is ambiguous.
    /// </exception>
    public static M2MFields DeriveM2MFields(MetaRelationship rel, MetaObject source, MetaRoot root)
    {
        // The entity that DECLARES `rel` — see the header note. Parent is the owning
        // entity for both an own declaration and an inherited one (an unmodified
        // inherited child is the SAME node object; an override is a different node
        // whose parent is the overriding entity, also correct).
        var declaring = rel.Parent as MetaObject ?? source;
        // The relationship's subject: either name is valid (see the header note).
        var subjectNames = declaring.Name == source.Name
            ? new[] { declaring.Name }
            : new[] { declaring.Name, source.Name };
        var subjectLabel = string.Join(" or ", subjectNames.Select(n => $"\"{n}\""));
        // Compared by resolved object IDENTITY, matching the Java reference. A
        // StripPackage compare cannot distinguish `a::NodeBase` from `b::NodeBase`, so
        // with two names in the set a genuine cross-package hetero M:N read as a
        // self-join and refused to derive.
        bool IsSubject(MetaObject? entity) =>
            entity is not null && (ReferenceEquals(entity, declaring) || ReferenceEquals(entity, source));
        bool IsSubjectName(string? name) => name is not null && subjectNames.Contains(StripPackage(name));

        string? throughName = rel.Through;
        if (throughName is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{declaring.Name}.{rel.Name}\" is missing @through (required for M:N derivation)");
        }

        var junction = root.FindObject(throughName);
        if (junction is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{declaring.Name}.{rel.Name}\" @through \"{throughName}\" does not resolve to an entity");
        }

        string? targetName = rel.ObjectRef;
        if (targetName is null)
        {
            throw new M2MDerivationException(
                $"relationship \"{declaring.Name}.{rel.Name}\" is missing @objectRef (the M:N target)");
        }

        var refs = junction.ReferenceIdentities();
        if (refs.Count != 2)
        {
            throw new M2MDerivationException(
                $"junction \"{throughName}\" for relationship \"{declaring.Name}.{rel.Name}\" must declare exactly two " +
                $"identity.reference children (found {refs.Count})");
        }

        // Defensive bare fallback when @objectRef does not resolve — loader validation
        // normally guarantees it does. Same carve-out the Java reference makes.
        var targetEntityNode = FindEntity(root, targetName);
        bool isSelfJoin = targetEntityNode is not null
            ? IsSubject(targetEntityNode)
            : IsSubjectName(targetName);

        if (!isSelfJoin)
        {
            // Hetero: match each reference by the ENTITY OBJECT it resolves to.
            var sourceRef = refs.FirstOrDefault(r => IsSubject(FindEntity(root, r.TargetEntity)));
            // Identity here too. The two searches are INDEPENDENT — nothing excludes
            // sourceRef from this one, unlike the directed self-join branch below — so a
            // bare compare could match the SOURCE-side reference again whenever the
            // target's short name equals the source's, and silently return (srcFk, srcFk).
            // Java matches identity on both sides (findRefToSubject + findRefToObject).
            var targetRef = targetEntityNode is not null
                ? refs.FirstOrDefault(r => ReferenceEquals(FindEntity(root, r.TargetEntity), targetEntityNode))
                : refs.FirstOrDefault(
                    r => r.TargetEntity is not null && StripPackage(r.TargetEntity) == StripPackage(targetName));
            var sourceField = sourceRef is not null ? RefFkField(sourceRef) : null;
            var targetField = targetRef is not null ? RefFkField(targetRef) : null;
            if (sourceField is null || targetField is null)
            {
                throw new M2MDerivationException(
                    $"junction \"{throughName}\" for relationship \"{declaring.Name}.{rel.Name}\" must declare one " +
                    $"identity.reference to {subjectLabel} and one to \"{StripPackage(targetName)}\"");
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
                    $"symmetric junction \"{throughName}\" for \"{declaring.Name}.{rel.Name}\" has a reference with no @fields");
            }
            return new M2MFields(a, b);
        }

        string? sourceRefField = rel.SourceRefField;
        if (sourceRefField is null)
        {
            throw new M2MDerivationException(
                $"self-join relationship \"{declaring.Name}.{rel.Name}\" through \"{throughName}\" is ambiguous: " +
                "set @sourceRefField (directed) or @symmetric (undirected)");
        }

        // Directed self-join: @sourceRefField names the source-side FK; the other ref is the target.
        var directedSourceRef = refs.FirstOrDefault(r => RefFkField(r) == sourceRefField);
        if (directedSourceRef is null)
        {
            throw new M2MDerivationException(
                $"@sourceRefField \"{sourceRefField}\" on \"{declaring.Name}.{rel.Name}\" does not match any " +
                $"identity.reference FK field on junction \"{throughName}\"");
        }
        var directedTargetRef = refs.FirstOrDefault(r => !ReferenceEquals(r, directedSourceRef));
        var directedTargetField = directedTargetRef is not null ? RefFkField(directedTargetRef) : null;
        if (directedTargetField is null)
        {
            throw new M2MDerivationException(
                $"junction \"{throughName}\" for \"{declaring.Name}.{rel.Name}\" has no distinct target-side reference");
        }
        return new M2MFields(sourceRefField, directedTargetField);
    }
}
