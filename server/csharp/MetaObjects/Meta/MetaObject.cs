// MetaObject — concrete node class for type=object nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-object.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>object.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaObject(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>
    /// All effective <c>source.*</c> children (own + inherited via extends).
    /// Mirrors Java's <c>getSources(true)</c>; ordering preserves declaration order
    /// (own-first, then super chain).
    /// </summary>
    public IReadOnlyList<MetaSource> Sources()
    {
        return Cached("sources", () =>
            (IReadOnlyList<MetaSource>)Children()
                .OfType<MetaSource>()
                .ToArray());
    }

    /// <summary>Own <c>source.*</c> children only — no inheritance walk.</summary>
    public IReadOnlyList<MetaSource> OwnSources()
    {
        return Cached("ownSources", () =>
            (IReadOnlyList<MetaSource>)OwnChildren()
                .OfType<MetaSource>()
                .ToArray());
    }

    /// <summary>
    /// The primary writable <c>source.rdb</c> — the first effective source whose
    /// role is "primary" and kind is writable (table). Walks the extends chain so
    /// a projection (which declares its own read-only source) still inherits the
    /// parent entity's writable source. The ValidationPasses one-primary rule
    /// guarantees at most one primary per object (own-only).
    /// </summary>
    public MetaSource? FindPrimaryWritableSource()
    {
        return Cached("primaryWritableSource", () =>
            Sources().FirstOrDefault(s => s.Role == SOURCE_ROLE_PRIMARY && s.IsWritable()));
    }

    /// <summary>
    /// The primary read-only <c>source.rdb</c> — the first OWN source whose role
    /// is "primary" and kind is read-only (view/materializedView/storedProc/
    /// tableFunction). Own-only: a projection declares its own read-only source;
    /// the parent entity's writable source is reached via
    /// <see cref="FindPrimaryWritableSource"/>.
    /// </summary>
    public MetaSource? FindPrimaryReadOnlySource()
    {
        return Cached("primaryReadOnlySource", () =>
            OwnSources().FirstOrDefault(s => s.Role == SOURCE_ROLE_PRIMARY && s.IsReadOnly()));
    }

    /// <summary>
    /// The physical <c>@table</c> name from the primary writable <c>source.rdb</c>
    /// (source-v2 ADR-0007). Walks the extends chain. Replaces the legacy object-
    /// level <c>@dbTable</c> attr (dropped in source-v2). Returns null when the
    /// object has no primary writable source.
    /// </summary>
    public string? DbTable => Cached("dbTable", () =>
        FindPrimaryWritableSource()?.TableName);

    /// <summary>
    /// The physical <c>@table</c> name from the primary read-only <c>source.rdb</c>
    /// (source-v2 ADR-0007). Own-only — used for projections. Replaces the legacy
    /// object-level <c>@dbView</c> attr (dropped in source-v2). Returns null when
    /// the object has no primary read-only source.
    /// </summary>
    public string? DbView => Cached("dbView", () =>
        FindPrimaryReadOnlySource()?.TableName);

    /// <summary>
    /// True when this object is a read-only projection: it has a read-only primary
    /// source and no writable primary source (queries target the view; nothing to
    /// write). Write-through objects (a read-only and a writable primary) are NOT
    /// read-only projections — they're CQRS write-through.
    /// </summary>
    public bool IsReadOnlyProjection() => DbView is not null && DbTable is null;

    /// <summary>True when the object's subtype is <c>entity</c>.</summary>
    public bool IsEntity() => SubType == OBJECT_SUBTYPE_ENTITY;

    /// <summary>True when the object's subtype is <c>value</c>.</summary>
    public bool IsValue() => SubType == OBJECT_SUBTYPE_VALUE;

    // -------------------------------------------------------------------------
    // Fields
    // -------------------------------------------------------------------------

    /// <summary>All effective fields (own + inherited via extends).</summary>
    public IReadOnlyList<MetaField> Fields()
    {
        return Cached("fields", () =>
            (IReadOnlyList<MetaField>)Children()
                .Where(c => c is MetaField)
                .Cast<MetaField>()
                .ToArray());
    }

    /// <summary>Own fields only — excludes fields inherited via extends.</summary>
    public IReadOnlyList<MetaField> OwnFields()
    {
        return Cached("ownFields", () =>
            (IReadOnlyList<MetaField>)OwnChildren()
                .Where(c => c is MetaField)
                .Cast<MetaField>()
                .ToArray());
    }

    /// <summary>Find an effective field by name, or <see langword="null"/>.</summary>
    public MetaField? FindField(string fieldName)
    {
        return Cached($"findField:{fieldName}", () =>
            Fields().FirstOrDefault(f => f.Name == fieldName));
    }

    // -------------------------------------------------------------------------
    // Identities
    // -------------------------------------------------------------------------

    /// <summary>All effective identities (own + inherited via extends).</summary>
    public IReadOnlyList<MetaIdentity> Identities()
    {
        return Cached("identities", () =>
            (IReadOnlyList<MetaIdentity>)Children()
                .Where(c => c is MetaIdentity)
                .Cast<MetaIdentity>()
                .ToArray());
    }

    /// <summary>Own identities only — excludes inherited.</summary>
    public IReadOnlyList<MetaIdentity> OwnIdentities()
    {
        return Cached("ownIdentities", () =>
            (IReadOnlyList<MetaIdentity>)OwnChildren()
                .Where(c => c is MetaIdentity)
                .Cast<MetaIdentity>()
                .ToArray());
    }

    /// <summary>The single primary identity, if any.</summary>
    public MetaIdentity? PrimaryIdentity()
    {
        return Cached("primaryIdentity", () =>
            Identities().FirstOrDefault(i => i.SubType == IDENTITY_SUBTYPE_PRIMARY));
    }

    /// <summary>All secondary identities.</summary>
    public IReadOnlyList<MetaIdentity> SecondaryIdentities()
    {
        return Cached("secondaryIdentities", () =>
            (IReadOnlyList<MetaIdentity>)Identities()
                .Where(i => i.SubType == IDENTITY_SUBTYPE_SECONDARY)
                .ToArray());
    }

    /// <summary>All reference identities (foreign keys) — the FK-resolution source for codegen/migrate.</summary>
    public IReadOnlyList<MetaReferenceIdentity> ReferenceIdentities()
    {
        return Cached("referenceIdentities", () =>
            (IReadOnlyList<MetaReferenceIdentity>)Identities()
                .OfType<MetaReferenceIdentity>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Relationships
    // -------------------------------------------------------------------------

    /// <summary>All effective relationships (own + inherited via extends).</summary>
    public IReadOnlyList<MetaRelationship> Relationships()
    {
        return Cached("relationships", () =>
            (IReadOnlyList<MetaRelationship>)Children()
                .Where(c => c is MetaRelationship)
                .Cast<MetaRelationship>()
                .ToArray());
    }

    /// <summary>Own relationships only — excludes inherited.</summary>
    public IReadOnlyList<MetaRelationship> OwnRelationships()
    {
        return Cached("ownRelationships", () =>
            (IReadOnlyList<MetaRelationship>)OwnChildren()
                .Where(c => c is MetaRelationship)
                .Cast<MetaRelationship>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Validators
    // -------------------------------------------------------------------------

    /// <summary>All effective validators (own + inherited via extends).</summary>
    public IReadOnlyList<MetaValidator> Validators()
    {
        return Cached("validators", () =>
            (IReadOnlyList<MetaValidator>)Children()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    /// <summary>Own validators only — excludes inherited.</summary>
    public IReadOnlyList<MetaValidator> OwnValidators()
    {
        return Cached("ownValidators", () =>
            (IReadOnlyList<MetaValidator>)OwnChildren()
                .Where(c => c is MetaValidator)
                .Cast<MetaValidator>()
                .ToArray());
    }

    // -------------------------------------------------------------------------
    // Layouts
    // -------------------------------------------------------------------------

    /// <summary>All effective layouts (own + inherited via extends).</summary>
    public IReadOnlyList<MetaLayout> Layouts()
    {
        return Cached("layouts", () =>
            (IReadOnlyList<MetaLayout>)Children()
                .Where(c => c is MetaLayout)
                .Cast<MetaLayout>()
                .ToArray());
    }

    /// <summary>Own layouts only — excludes inherited.</summary>
    public IReadOnlyList<MetaLayout> OwnLayouts()
    {
        return Cached("ownLayouts", () =>
            (IReadOnlyList<MetaLayout>)OwnChildren()
                .Where(c => c is MetaLayout)
                .Cast<MetaLayout>()
                .ToArray());
    }
}
