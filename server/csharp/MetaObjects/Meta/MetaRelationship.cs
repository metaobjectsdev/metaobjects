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

    /// <summary>Name of the FK field on the source entity (for one-to-many / many-to-one).</summary>
    public string? FkField
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_FK_FIELD);
            return v is string s ? s : null;
        }
    }

    /// <summary>Join-table entity name for N:M relationships.</summary>
    public string? JoinEntity
    {
        get
        {
            var v = OwnAttr(RELATIONSHIP_ATTR_JOIN_ENTITY);
            return v is string s ? s : null;
        }
    }

    /// <summary>Join-table column names for N:M relationships.</summary>
    public IReadOnlyList<string> JoinFields
    {
        get
        {
            var f = OwnAttr(RELATIONSHIP_ATTR_JOIN_FIELDS);
            return f is IReadOnlyList<string> list ? list : [];
        }
    }
}
