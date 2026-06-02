// MetaRelationship — concrete node class for type=relationship nodes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-relationship.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>relationship.*</c> nodes.
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaRelationship(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>Relationship cardinality (e.g. <c>"one"</c> or <c>"many"</c>).</summary>
    public string? Cardinality
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_CARDINALITY);
            return v is string s ? s : null;
        }
    }

    /// <summary>FQN of the target object (e.g. <c>"acme::vehicle::Car"</c>).</summary>
    public string? ObjectRef
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_OBJECT_REF);
            return v is string s ? s : null;
        }
    }

    /// <summary>Junction (through) entity name for M:N relationships.</summary>
    public string? Through
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_THROUGH);
            return v is string s ? s : null;
        }
    }

    /// <summary>Source-side FK field on the junction (directed self-join disambiguator).</summary>
    public string? SourceRefField
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD);
            return v is string s ? s : null;
        }
    }

    /// <summary>Whether this M:N relationship is an undirected (symmetric) self-join.</summary>
    public bool Symmetric => OwnAttr(RELATIONSHIP_ATTR_SYMMETRIC) is true;

    /// <summary>
    /// The effective FK referential action on parent delete — the explicit
    /// <c>@onDelete</c>, else the per-subtype default
    /// (<see cref="ON_DELETE_DEFAULT_BY_SUBTYPE"/>).
    /// </summary>
    public string EffectiveOnDelete
    {
        get
        {
            if (OwnAttr(RELATIONSHIP_ATTR_ON_DELETE) is string s && s != "") return s;
            return ON_DELETE_DEFAULT_BY_SUBTYPE.TryGetValue(SubType, out var def)
                ? def : ACTION_RESTRICT;
        }
    }

    /// <summary>
    /// The effective FK referential action on parent key update — the explicit
    /// <c>@onUpdate</c>, else <see cref="ON_UPDATE_DEFAULT"/>.
    /// </summary>
    public string EffectiveOnUpdate
    {
        get
        {
            if (OwnAttr(RELATIONSHIP_ATTR_ON_UPDATE) is string s && s != "") return s;
            return ON_UPDATE_DEFAULT;
        }
    }
}
