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
    /// </summary>
    public string? DbTable => Cached("dbTable", () =>
    {
        var source = Children().FirstOrDefault(
            c => c.Type == Constants.TYPE_SOURCE && c.SubType == Constants.SOURCE_SUBTYPE_DB_TABLE);
        var n = source?.OwnAttr(Constants.SOURCE_DB_TABLE_ATTR_NAME);
        return n is string s && s != "" ? s : null;
    });

    /// <summary>Java runtime materialization strategy from <c>@javaRuntime</c>.</summary>
    public string? JavaRuntime
    {
        get
        {
            var v = OwnAttr(Constants.OBJECT_ATTR_JAVA_RUNTIME);
            return v is string s ? s : null;
        }
    }

    /// <summary>True when the object's subtype is <c>entity</c>.</summary>
    public bool IsEntity() => SubType == Constants.OBJECT_SUBTYPE_ENTITY;

    /// <summary>True when the object's subtype is <c>value</c>.</summary>
    public bool IsValue() => SubType == Constants.OBJECT_SUBTYPE_VALUE;

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
            Identities().FirstOrDefault(i => i.SubType == Constants.IDENTITY_SUBTYPE_PRIMARY));
    }

    /// <summary>All secondary identities.</summary>
    public IReadOnlyList<MetaIdentity> SecondaryIdentities()
    {
        return Cached("secondaryIdentities", () =>
            (IReadOnlyList<MetaIdentity>)Identities()
                .Where(i => i.SubType == Constants.IDENTITY_SUBTYPE_SECONDARY)
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
