// MetaIdentity — concrete node class for type=identity nodes.
// MetaPrimaryIdentity and MetaSecondaryIdentity are co-located subtype classes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-identity.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete base node class for <c>identity.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaIdentity(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The field names that form this identity key.</summary>
    public IReadOnlyList<string> Fields
    {
        get
        {
            var f = OwnAttr(IDENTITY_ATTR_FIELDS);
            return f is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>
    /// Whether the identity enforces uniqueness.
    /// Defaults to <see langword="true"/>; explicit <c>@unique: false</c> makes it a non-unique index.
    /// </summary>
    public bool Unique => OwnAttr(IDENTITY_ATTR_UNIQUE) is not false;

    /// <summary>True when this identity's subtype is <c>primary</c>.</summary>
    public bool IsPrimary() => SubType == IDENTITY_SUBTYPE_PRIMARY;

    /// <summary>True when this identity's subtype is <c>secondary</c>.</summary>
    public bool IsSecondary() => SubType == IDENTITY_SUBTYPE_SECONDARY;

    /// <summary>True when this identity is composite (more than one field).</summary>
    public bool IsComposite() => Fields.Count > 1;
}

/// <summary>
/// Primary identity (the entity's PK). Always unique by definition.
/// Carries <c>@generation</c> (increment / uuid / assigned).
/// </summary>
public class MetaPrimaryIdentity(TypeId typeId, string name) : MetaIdentity(typeId, name)
{
    /// <summary>The PK generation strategy (<c>"increment"</c>, <c>"uuid"</c>, or <c>"assigned"</c>).</summary>
    public string? Generation
    {
        get
        {
            var v = OwnAttr(IDENTITY_ATTR_GENERATION);
            return v is string s ? s : null;
        }
    }
}

/// <summary>
/// Secondary identity — a unique or non-unique index on one or more fields.
/// <c>@generation</c> does not apply here.
/// </summary>
public class MetaSecondaryIdentity(TypeId typeId, string name) : MetaIdentity(typeId, name) { }
