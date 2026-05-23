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
    /// The SQL table name from the first <c>source[dbTable]</c> child,
    /// or <see langword="null"/> when none is declared.
    /// Uses effective <see cref="MetaData.Children"/> (not <see cref="MetaData.OwnChildren"/>)
    /// because a <c>source</c> node can be inherited via the super chain — mirrors TS.
    /// </summary>
    public string? DbTable => Cached("dbTable", () =>
    {
        var source = Children().FirstOrDefault(
            c => c.Type == TYPE_SOURCE && c.SubType == SOURCE_SUBTYPE_DB_TABLE);
        var n = source?.OwnAttr(SOURCE_DB_TABLE_ATTR_NAME);
        return n is string s && s != "" ? s : null;
    });

    /// <summary>
    /// The SQL view name from the first <c>source[dbView]</c> child, or null when
    /// none is declared. Uses effective <see cref="MetaData.Children"/> (a source
    /// node can be inherited via the super chain).
    /// </summary>
    public string? DbView => Cached("dbView", () =>
    {
        var source = Children().FirstOrDefault(
            c => c.Type == TYPE_SOURCE && c.SubType == SOURCE_SUBTYPE_DB_VIEW);
        var n = source?.OwnAttr(SOURCE_DB_VIEW_ATTR_NAME);
        return n is string s && s != "" ? s : null;
    });

    /// <summary>
    /// True when this object is a read-only projection: it has a <c>dbView</c>
    /// source and no <c>dbTable</c> (queries target the view; there is nothing to
    /// write). Write-through objects (both dbTable + dbView) are not read-only.
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
