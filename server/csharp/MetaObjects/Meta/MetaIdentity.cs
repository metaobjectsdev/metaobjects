// MetaIdentity — concrete node class for type=identity nodes.
// MetaPrimaryIdentity and MetaSecondaryIdentity are co-located subtype classes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-identity.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete base node class for <c>identity.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
// ADR-0039: identity attr getters use the RESOLVING Attr() accessor — an identity
// attr (@fields, @generation, @references, @enforce, ...) may be inherited from an
// abstract base via extends. This is the resolving reference the other node classes
// (MetaSource / MetaRelationship) were reconciled to.
public class MetaIdentity(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>The field names that form this identity key.</summary>
    public IReadOnlyList<string> Fields
    {
        get
        {
            var f = Attr(IDENTITY_ATTR_FIELDS);
            return f is IReadOnlyList<string> list ? list : [];
        }
    }

    /// <summary>True when this identity's subtype is <c>primary</c>.</summary>
    public bool IsPrimary() => SubType == IDENTITY_SUBTYPE_PRIMARY;

    /// <summary>True when this identity's subtype is <c>secondary</c>.</summary>
    public bool IsSecondary() => SubType == IDENTITY_SUBTYPE_SECONDARY;

    /// <summary>True when this identity's subtype is <c>reference</c> (a foreign key).</summary>
    public bool IsReference() => SubType == IDENTITY_SUBTYPE_REFERENCE;

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
            var v = Attr(IDENTITY_ATTR_GENERATION);
            return v is string s ? s : null;
        }
    }
}

/// <summary>
/// Secondary identity — a unique or non-unique index on one or more fields.
/// <c>@generation</c> does not apply here.
/// </summary>
public class MetaSecondaryIdentity(TypeId typeId, string name) : MetaIdentity(typeId, name) { }

/// <summary>
/// Reference identity (FR-003) — a foreign key. The local <c>@fields</c> hold the
/// FK; <c>@references</c> names the target (bare entity → its primary identity, or
/// dotted <c>Entity.field[,field]</c>). <c>@enforce</c> (default true) toggles a hard
/// FK constraint vs. a logical-only reference.
/// </summary>
public class MetaReferenceIdentity(TypeId typeId, string name) : MetaIdentity(typeId, name)
{
    /// <summary>Raw <c>@references</c> value, unparsed.</summary>
    public string? ReferencesRaw =>
        Attr(IDENTITY_REFERENCE_ATTR_REFERENCES) is string s ? s : null;

    /// <summary>Target entity name (the part before the dot, or the whole bare value).</summary>
    public string? TargetEntity
    {
        get
        {
            var raw = ReferencesRaw;
            if (raw is null) return null;
            int dot = raw.IndexOf('.');
            return dot < 0 ? raw : raw[..dot];
        }
    }

    /// <summary>
    /// Target field names. Empty = "use the target's primary identity" (bare form);
    /// otherwise the comma-split, trimmed field(s) after the dot.
    /// </summary>
    public IReadOnlyList<string> TargetFields
    {
        get
        {
            var raw = ReferencesRaw;
            if (raw is null) return [];
            int dot = raw.IndexOf('.');
            if (dot < 0) return [];
            return raw[(dot + 1)..].Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
        }
    }

    /// <summary>Whether the reference is physically enforced (default true; <c>@enforce: false</c> = logical-only).</summary>
    public bool Enforce => Attr(IDENTITY_REFERENCE_ATTR_ENFORCE) is not false;
}
