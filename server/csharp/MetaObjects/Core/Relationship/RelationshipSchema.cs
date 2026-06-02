// Relationship attribute schemas — attrs common to every relationship subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/relationship/relationship-schema.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Relationship;

/// <summary>Attribute schemas for the relationship concern.</summary>
public static class RelationshipSchema
{
    /// <summary>Attrs common to every relationship subtype.</summary>
    public static readonly IReadOnlyList<AttrSchema> RelationshipAttrs =
    [
        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_CARDINALITY,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            // No AllowedValues: @cardinality is an open string at the metamodel level.
            // Java canonical fixtures use composite forms such as "many-to-one"; the
            // CARDINALITY_VALUES ("one"/"many") constant is a TS codegen convenience,
            // NOT a closed metamodel enum. A3 must not reject Java-canonical values.
            Description: "Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one')."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_OBJECT_REF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car')."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_THROUGH,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Junction (through) entity name for M:N relationships — a third entity declaring two identity.reference children, one per FK side. The relationship's FK fields are derived from those references."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Directed self-join disambiguator: names the source-side FK field on the junction (the other reference is the target side). Required only for directed/ambiguous self-join M:N. Mutually exclusive with @symmetric."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_SYMMETRIC,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "Undirected self-join flag (union-on-read). Valid only when @objectRef == the declaring entity. Mutually exclusive with @sourceRefField."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_ON_DELETE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. RelationshipConstants.REFERENTIAL_ACTIONS],
            Description: "FK referential action on parent delete: cascade, set-null, restrict, or no-action. Default depends on subtype (composition→cascade, aggregation→set-null, association→restrict)."),

        new AttrSchema(
            Name: RelationshipConstants.RELATIONSHIP_ATTR_ON_UPDATE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. RelationshipConstants.REFERENTIAL_ACTIONS],
            Description: "FK referential action on parent key update: cascade, set-null, restrict, or no-action. Default: cascade."),
    ];
}
