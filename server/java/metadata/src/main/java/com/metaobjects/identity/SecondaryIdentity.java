package com.metaobjects.identity;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.metaobjects.object.MetaObject.ATTR_DESCRIPTION;
import static com.metaobjects.attr.StringAttribute.SUBTYPE_STRING;

/**
 * Secondary identity for business keys and alternate identifiers. Objects can have multiple
 * secondary identities for different business scenarios like email addresses, SKU codes, etc.
 *
 * Secondary identities typically use application-assigned values rather than auto-generation.
 */
public class SecondaryIdentity extends MetaIdentity {

    private static final Logger log = LoggerFactory.getLogger(SecondaryIdentity.class);

    /**
     * RDB-physical index attrs — contributed by the db provider via
     * {@code registry.extendType} (mirroring the TS db provider's {@code extends} blocks).
     * Kept as constants here for cross-module consumers that resolve them by name.
     *
     * NOTE: {@code @unique} was removed from {@code identity.secondary} — uniqueness is
     * an inherent property of the subtype (secondary identities ALWAYS enforce uniqueness).
     * For a non-unique query-performance index, use {@code index.lookup} instead.
     */
    /** Physical index-key sort direction array (asc|desc) — db-provider attr (RDB-physical). */
    public static final String ATTR_ORDERS = "orders";
    /** Partial-index predicate (raw SQL) — db-provider attr (RDB-physical). */
    public static final String ATTR_WHERE = "where";
    /** Raw key EXPRESSION for a functional/expression index — db-provider attr (RDB-physical). */
    public static final String ATTR_EXPR = "expr";
    /** Index access method (e.g. "gin"); default "btree" — db-provider attr (RDB-physical). */
    public static final String ATTR_USING = "using";

    public SecondaryIdentity(String name) {
        super(SUBTYPE_SECONDARY, name);
    }

    /**
     * Register SecondaryIdentity type with the MetaDataRegistry.
     * Called by IdentityTypesMetaDataProvider during service discovery.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(SecondaryIdentity.class, def -> {
            def.type(TYPE_IDENTITY).subType(SUBTYPE_SECONDARY)
               .description("Secondary identity for business keys and alternate identifiers")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE);

            // @fields is REQUIRED on identity.secondary (cross-port canonical).
            // @generation is NOT a secondary-identity attr in the canonical (it is
            // primary-only) — intentionally not declared here.
            // @unique is removed: secondary identities ALWAYS enforce uniqueness —
            // it is an inherent property of the subtype, not an attr to be toggled.
            // For a non-unique query-performance index, use index.lookup instead.
            def.requiredAttributeWithConstraints(ATTR_FIELDS).ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ATTR_DESCRIPTION).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            // RDB-physical index attrs (@orders / @where / @expr / @using) are
            // contributed by CoreDBMetaDataProvider via registry.extendType, mirroring
            // the TS db provider's "extends" blocks in spec/metamodel/db.json.

            // ACCEPTS ANY ATTRIBUTES (for extensibility from service providers)
            def.optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");
        });
    }

    /**
     * Returns true if this secondary identity represents a business key.
     * Business keys are stable, meaningful identifiers used by business users.
     */
    public boolean isBusinessKey() {
        // Secondary identities are by definition business keys
        return true;
    }

    /**
     * Returns true if this secondary identity uses natural (meaningful) values.
     * This is typically true for secondary keys like email, SKU, username, etc.
     */
    public boolean usesNaturalValues() {
        // Most secondary identities use natural values rather than generated ones
        String generation = getGeneration();
        return generation == null || GENERATION_ASSIGNED.equals(generation);
    }

    /**
     * Returns true if this secondary identity supports lookups and queries.
     * Secondary identities are often used for finding objects by business criteria.
     */
    public boolean supportsLookup() {
        return true;
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{%s -> %s}%s",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getName(),
            getFields(),
            isCompound() ? " [COMPOUND]" : " [SIMPLE]");
    }
}