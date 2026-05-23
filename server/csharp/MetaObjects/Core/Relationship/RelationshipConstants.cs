// Relationship concern constants — relationship subtypes, relationship attr
// keys, and cardinality values.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/relationship/relationship-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Core.Relationship;

/// <summary>
/// Relationship concern constants — the relationship subtypes (base, association,
/// aggregation, composition), the relationship attr keys, and cardinality values.
/// </summary>
public static class RelationshipConstants
{
    public const string RELATIONSHIP_SUBTYPE_ASSOCIATION = "association";
    public const string RELATIONSHIP_SUBTYPE_AGGREGATION = "aggregation";
    public const string RELATIONSHIP_SUBTYPE_COMPOSITION = "composition";

    public static readonly string[] RELATIONSHIP_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        RELATIONSHIP_SUBTYPE_ASSOCIATION,
        RELATIONSHIP_SUBTYPE_AGGREGATION,
        RELATIONSHIP_SUBTYPE_COMPOSITION,
    ];

    // Relationship attrs
    public const string RELATIONSHIP_ATTR_CARDINALITY  = "cardinality";
    public const string RELATIONSHIP_ATTR_OBJECT_REF   = "objectRef";
    public const string RELATIONSHIP_ATTR_FK_FIELD     = "fkField";
    /// <summary>The field name on the PARENT entity that the FK references. Defaults to the parent's primary identity field.</summary>
    public const string RELATIONSHIP_ATTR_PARENT_FIELD = "parentField";
    /// <summary>N:M cardinality.</summary>
    public const string RELATIONSHIP_ATTR_JOIN_ENTITY  = "joinEntity";
    /// <summary>N:M cardinality.</summary>
    public const string RELATIONSHIP_ATTR_JOIN_FIELDS  = "joinFields";

    // Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
    public const string CARDINALITY_ONE  = "one";
    public const string CARDINALITY_MANY = "many";

    public static readonly string[] CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY];
}
