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
    /// <summary>M:N junction (through) entity — a third entity declaring two identity.reference children.</summary>
    public const string RELATIONSHIP_ATTR_THROUGH = "through";
    /// <summary>M:N directed-self-join disambiguator — names the source-side FK field on the junction.</summary>
    public const string RELATIONSHIP_ATTR_SOURCE_REF_FIELD = "sourceRefField";
    /// <summary>M:N undirected-self-join flag — union-on-read; valid only when objectRef == the declaring entity.</summary>
    public const string RELATIONSHIP_ATTR_SYMMETRIC = "symmetric";

    // Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
    public const string CARDINALITY_ONE  = "one";
    public const string CARDINALITY_MANY = "many";

    public static readonly string[] CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY];

    // -----------------------------------------------------------------------
    // Referential action attrs (@onDelete / @onUpdate) — source-v2 / migrate.
    // -----------------------------------------------------------------------

    public const string RELATIONSHIP_ATTR_ON_DELETE = "onDelete";
    public const string RELATIONSHIP_ATTR_ON_UPDATE = "onUpdate";

    /// <summary>Referential action: parent delete cascades to children.</summary>
    public const string ACTION_CASCADE    = "cascade";
    /// <summary>Referential action: parent delete nulls the FK column.</summary>
    public const string ACTION_SET_NULL   = "set-null";
    /// <summary>Referential action: parent delete is refused if children exist.</summary>
    public const string ACTION_RESTRICT   = "restrict";
    /// <summary>Referential action: defer to DB default (no-action).</summary>
    public const string ACTION_NO_ACTION  = "no-action";

    /// <summary>The canonical cross-language referential-action set (kebab-case).
    /// MUST equal TS REFERENTIAL_ACTIONS and Java's MetaRelationship action constants.</summary>
    public static readonly string[] REFERENTIAL_ACTIONS =
    [
        ACTION_CASCADE,
        ACTION_SET_NULL,
        ACTION_RESTRICT,
        ACTION_NO_ACTION,
    ];

    /// <summary>Default @onDelete per relationship subtype (rollout decided defaults).</summary>
    public static readonly IReadOnlyDictionary<string, string> ON_DELETE_DEFAULT_BY_SUBTYPE =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [RELATIONSHIP_SUBTYPE_COMPOSITION] = ACTION_CASCADE,
            [RELATIONSHIP_SUBTYPE_AGGREGATION] = ACTION_SET_NULL,
            [RELATIONSHIP_SUBTYPE_ASSOCIATION] = ACTION_RESTRICT,
        };

    /// <summary>Default @onUpdate value across all relationship subtypes.</summary>
    public const string ON_UPDATE_DEFAULT = ACTION_CASCADE;
}
