package com.metaobjects.relationship;

import com.metaobjects.MetaData;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.metaobjects.object.MetaObject.ATTR_DESCRIPTION;

/**
 * Abstract base relationship metadata for expressing object relationships.
 * Provides simplified model-driven relationship patterns optimized for AI generation.
 *
 * This is an ABSTRACT base type - use concrete subtypes:
 * - CompositionRelationship: Parent exclusively owns child (dependent lifecycle)
 * - AggregationRelationship: Parent has shared ownership (shared lifecycle)
 * - AssociationRelationship: Parent references independent child (independent lifecycle)
 */
public abstract class MetaRelationship extends MetaData {

    private static final Logger log = LoggerFactory.getLogger(MetaRelationship.class);

    // === TYPE AND SUBTYPE CONSTANTS ===
    /** Relationship type constant - MetaRelationship owns this concept */
    public final static String TYPE_RELATIONSHIP = "relationship";

    /** Abstract base relationship subtype - NEVER instantiate directly */
    public final static String SUBTYPE_BASE = "base";

    // === ESSENTIAL ATTRIBUTES (AI specifies these 3) ===
    /** Target object that this relationship points to.
     *  Literal {@code "objectRef"} — Tier-1 cross-language vocabulary (matches the
     *  TS reference and shared conformance corpus). */
    public final static String ATTR_OBJECT_REF = "objectRef";

    /** Cardinality of relationship: "one" or "many" */
    public final static String ATTR_CARDINALITY = "cardinality";

    // SP-G: the legacy {@code @referencedBy} attr (the own FK-field name implementing
    // an N:1/1:1 association) was REMOVED. FK direction is the SSOT of
    // {@code identity.reference} ({@code @fields} / {@code @references}); consumers
    // derive FK-field-ness from those references (see codegen-mustache HelperRegistry).

    // === FR-017 M:N SLIM VOCABULARY ===
    /** Junction (through) entity name for M:N relationships — a third entity declaring two
     *  {@code identity.reference} children, one per FK side. The relationship's FK fields are
     *  derived from those references (never restated). Renamed from the retired {@code @joinEntity}. */
    public final static String ATTR_THROUGH = "through";

    /** Directed self-join disambiguator: names the source-side FK field on the junction
     *  (the other reference is the target side). Required only for directed/ambiguous self-join
     *  M:N. Mutually exclusive with {@code @symmetric}. */
    public final static String ATTR_SOURCE_REF_FIELD = "sourceRefField";

    /** Undirected self-join flag (union-on-read). Valid only when {@code @objectRef} == the
     *  declaring entity. Mutually exclusive with {@code @sourceRefField}. */
    public final static String ATTR_SYMMETRIC = "symmetric";

    // === CARDINALITY CONSTANTS ===
    public static final String CARDINALITY_ONE = "one";
    public static final String CARDINALITY_MANY = "many";

    // === LIFECYCLES ===
    public static final String LIFECYCLE_DEPENDENT = "dependent";
    public static final String LIFECYCLE_INDEPENDENT = "independent";
    public static final String LIFECYCLE_SHARED = "shared";

    // === REFERENTIAL ACTION ATTRIBUTES ===
    /** {@code @onDelete} attr: referential action taken when the referenced row is deleted. */
    public static final String ATTR_ON_DELETE = "onDelete";

    /** {@code @onUpdate} attr: referential action taken when the referenced key is updated. */
    public static final String ATTR_ON_UPDATE = "onUpdate";

    // === REFERENTIAL ACTION VALUES ===
    /** Referential actions — the canonical cross-language set (kebab-case, no setDefault).
     *  MUST equal the TS migrate-ts {@code FkAction} union:
     *  {@code cascade | set-null | restrict | no-action}. */
    public static final String ACTION_CASCADE    = "cascade";
    public static final String ACTION_SET_NULL   = "set-null";
    public static final String ACTION_RESTRICT   = "restrict";
    public static final String ACTION_NO_ACTION  = "no-action";

    /** Immutable set of all valid referential-action values. */
    public static final java.util.Set<String> REFERENTIAL_ACTIONS = java.util.Set.of(
        ACTION_CASCADE, ACTION_SET_NULL, ACTION_RESTRICT, ACTION_NO_ACTION
    );

    /** Default {@code @onDelete} per relationship subtype (rollout-decided defaults).
     *  Default-derivation lives in OMDB consumer code; these constants are exported
     *  for the deriver so it does not have to inline string literals. */
    public static final java.util.Map<String, String> ON_DELETE_DEFAULT_BY_SUBTYPE =
        java.util.Map.of(
            "composition", ACTION_CASCADE,
            "aggregation", ACTION_SET_NULL,
            "association", ACTION_RESTRICT
        );

    /** Default {@code @onUpdate} for all relationship subtypes (rollout-decided default). */
    public static final String ON_UPDATE_DEFAULT = ACTION_CASCADE;

    /**
     * Register this type with the MetaDataRegistry (called by provider)
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaRelationship.class, def -> {
            def.type(TYPE_RELATIONSHIP).subType(SUBTYPE_BASE)
               .description("Abstract base relationship metadata with model-driven patterns")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);
               // ACCEPTS ANY ATTRIBUTES (all relationship types inherit these)
               // ADR-0051: NO any-attr wildcard. An undeclared attribute is ERR_UNKNOWN_ATTR in
               // every port; extension is REGISTRATION -- a downstream provider declares its
               // attrs. A wildcard would also swallow a TYPO'd core attr, silently.

            // RELATIONSHIP-SPECIFIC ATTRIBUTES WITH FLUENT CONSTRAINTS
            def.optionalAttributeWithConstraints(ATTR_IS_ABSTRACT)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
               .asSingle();

            def.optionalAttributeWithConstraints(ATTR_OBJECT_REF)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            def.optionalAttributeWithConstraints(ATTR_CARDINALITY)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            // FR-017 M:N slim vocabulary — through / sourceRefField (string) + symmetric (boolean).
            def.optionalAttributeWithConstraints(ATTR_THROUGH)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            def.optionalAttributeWithConstraints(ATTR_SOURCE_REF_FIELD)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            def.optionalAttributeWithConstraints(ATTR_SYMMETRIC)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
               .asSingle();

            def.optionalAttributeWithConstraints(ATTR_DESCRIPTION)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            // @onDelete / @onUpdate — enum-constrained; withEnum also marks as single
            def.optionalAttributeWithConstraints(ATTR_ON_DELETE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(ACTION_CASCADE, ACTION_SET_NULL, ACTION_RESTRICT, ACTION_NO_ACTION);

            def.optionalAttributeWithConstraints(ATTR_ON_UPDATE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(ACTION_CASCADE, ACTION_SET_NULL, ACTION_RESTRICT, ACTION_NO_ACTION);
        });
    }

    protected MetaRelationship(String subType, String name) {
        super(TYPE_RELATIONSHIP, subType, name);
    }

    // === ESSENTIAL ATTRIBUTE ACCESSORS ===

    public String getObjectRef() {
        return hasMetaAttr(ATTR_OBJECT_REF) ?
               getMetaAttr(ATTR_OBJECT_REF).getValueAsString() : null;
    }

    public String getCardinality() {
        return hasMetaAttr(ATTR_CARDINALITY) ?
               getMetaAttr(ATTR_CARDINALITY).getValueAsString() : CARDINALITY_ONE;
    }

    // === FR-017 M:N ACCESSORS ===

    /** Junction (through) entity name for M:N relationships, or {@code null} if not set. */
    public String getThrough() {
        return hasMetaAttr(ATTR_THROUGH) ?
               getMetaAttr(ATTR_THROUGH).getValueAsString() : null;
    }

    /** Source-side FK field on the junction (directed self-join disambiguator),
     *  or {@code null} if not set. */
    public String getSourceRefField() {
        return hasMetaAttr(ATTR_SOURCE_REF_FIELD) ?
               getMetaAttr(ATTR_SOURCE_REF_FIELD).getValueAsString() : null;
    }

    /** Whether this M:N relationship is an undirected (symmetric) self-join.
     *  {@code false} when the attr is absent. */
    public boolean isSymmetric() {
        return hasMetaAttr(ATTR_SYMMETRIC)
            && Boolean.parseBoolean(getMetaAttr(ATTR_SYMMETRIC).getValueAsString());
    }

    /** Raw value of {@code @onDelete} attr, or {@code null} if not set.
     *  Default-derivation (composition→cascade, aggregation→set-null, association→restrict)
     *  lives in OMDB consumer code; use {@link #ON_DELETE_DEFAULT_BY_SUBTYPE} for that. */
    public String getOnDeleteRaw() {
        return hasMetaAttr(ATTR_ON_DELETE) ?
               getMetaAttr(ATTR_ON_DELETE).getValueAsString() : null;
    }

    /** Raw value of {@code @onUpdate} attr, or {@code null} if not set.
     *  Default is {@link #ON_UPDATE_DEFAULT} ({@code cascade}); derivation lives in consumers. */
    public String getOnUpdateRaw() {
        return hasMetaAttr(ATTR_ON_UPDATE) ?
               getMetaAttr(ATTR_ON_UPDATE).getValueAsString() : null;
    }

    /**
     * Returns lifecycle dependency based on subtype.
     */
    public abstract String getLifecycle();


    public boolean isOneToOne() {
        return CARDINALITY_ONE.equals(getCardinality());
    }

    public boolean isOneToMany() {
        return CARDINALITY_MANY.equals(getCardinality());
    }

    /**
     * Convenience method: Check if this relationship represents ownership (composition/aggregation)
     */
    public abstract boolean isOwning();

    /**
     * Convenience method: Check if this relationship represents a reference (association)
     */
    public abstract boolean isReferencing();

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{%s -> %s (%s)}",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getName(),
            getObjectRef(),
            getCardinality());
    }
}