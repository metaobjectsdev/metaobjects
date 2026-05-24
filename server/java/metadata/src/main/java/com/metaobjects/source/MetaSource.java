package com.metaobjects.source;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

import java.util.Set;

/**
 * Abstract base source metadata — describes where an object's data lives.
 *
 * <p>Concrete subtypes:</p>
 * <ul>
 *   <li>{@link RdbSource} ({@code source.rdb}) — relational database table/view/stored proc.</li>
 * </ul>
 *
 * <p>Read-only-ness is derived from {@code @kind}: view / materializedView / storedProc /
 * tableFunction are read-only; table (the default) is writable.</p>
 */
public abstract class MetaSource extends MetaData {

    // === TYPE AND SUBTYPE CONSTANTS ===

    /** Source type constant — MetaSource owns this concept. */
    public static final String TYPE_SOURCE = "source";

    /** Abstract base source subtype — never instantiate directly. */
    public static final String SUBTYPE_BASE = "base";

    // === ATTRIBUTE NAME CONSTANTS ===

    /** Physical table/view name. Defaults to the logical entity name via the naming strategy. */
    public static final String ATTR_TABLE = "table";

    /** Object kind: table / view / materializedView / storedProc / tableFunction. */
    public static final String ATTR_KIND = "kind";

    /** Multi-source role: primary / replica / index / cache / publish / mirror. */
    public static final String ATTR_ROLE = "role";

    /** DB schema / namespace (Postgres default "public"; SQLite rejects non-default values). */
    public static final String ATTR_SCHEMA = "schema";

    // === KIND VALUE CONSTANTS ===

    public static final String KIND_TABLE             = "table";
    public static final String KIND_VIEW              = "view";
    public static final String KIND_MATERIALIZED_VIEW = "materializedView";
    public static final String KIND_STORED_PROC       = "storedProc";
    public static final String KIND_TABLE_FUNCTION    = "tableFunction";

    /** Default kind when {@code @kind} is absent. */
    public static final String DEFAULT_KIND = KIND_TABLE;

    /**
     * The set of {@code @kind} values that make a source read-only.
     * Derived: {@code isReadOnly() = READ_ONLY_KINDS.contains(getEffectiveKind())}.
     */
    public static final Set<String> READ_ONLY_KINDS = Set.of(
        KIND_VIEW,
        KIND_MATERIALIZED_VIEW,
        KIND_STORED_PROC,
        KIND_TABLE_FUNCTION
    );

    // === ROLE VALUE CONSTANTS ===

    public static final String ROLE_PRIMARY = "primary";
    public static final String ROLE_REPLICA = "replica";
    public static final String ROLE_INDEX   = "index";
    public static final String ROLE_CACHE   = "cache";
    public static final String ROLE_PUBLISH = "publish";
    public static final String ROLE_MIRROR  = "mirror";

    /** Default role when {@code @role} is absent. */
    public static final String DEFAULT_ROLE = ROLE_PRIMARY;

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    protected MetaSource(String subType, String name) {
        super(TYPE_SOURCE, subType, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the abstract {@code source.base} type with all four attrs declared.
     * Called by {@link SourceTypesMetaDataProvider}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaSource.class, def -> {
            def.type(TYPE_SOURCE).subType(SUBTYPE_BASE)
               .description("Abstract base source metadata — describes where an object's data lives")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               // Accept any attr child (for extensibility)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");

            // @table — physical name; optional, string, single value
            def.optionalAttributeWithConstraints(ATTR_TABLE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();

            // @kind — enum-constrained; withEnum also marks it as single
            def.optionalAttributeWithConstraints(ATTR_KIND)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(
                   KIND_TABLE,
                   KIND_VIEW,
                   KIND_MATERIALIZED_VIEW,
                   KIND_STORED_PROC,
                   KIND_TABLE_FUNCTION
               );

            // @role — enum-constrained; withEnum also marks it as single
            def.optionalAttributeWithConstraints(ATTR_ROLE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(
                   ROLE_PRIMARY,
                   ROLE_REPLICA,
                   ROLE_INDEX,
                   ROLE_CACHE,
                   ROLE_PUBLISH,
                   ROLE_MIRROR
               );

            // @schema — optional, string, single value
            def.optionalAttributeWithConstraints(ATTR_SCHEMA)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .asSingle();
        });
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    /**
     * Returns the value of {@code @table}, or {@code null} if absent.
     * Callers should fall back to the entity's logical name via the naming strategy.
     */
    public String getTableName() {
        return hasMetaAttr(ATTR_TABLE)
            ? getMetaAttr(ATTR_TABLE).getValueAsString()
            : null;
    }

    /**
     * Returns the {@code @kind} value, defaulting to {@link #DEFAULT_KIND} ("table")
     * when the attribute is absent.
     */
    public String getEffectiveKind() {
        return hasMetaAttr(ATTR_KIND)
            ? getMetaAttr(ATTR_KIND).getValueAsString()
            : DEFAULT_KIND;
    }

    /**
     * Returns the {@code @role} value, defaulting to {@link #DEFAULT_ROLE} ("primary")
     * when the attribute is absent.
     */
    public String getRole() {
        return hasMetaAttr(ATTR_ROLE)
            ? getMetaAttr(ATTR_ROLE).getValueAsString()
            : DEFAULT_ROLE;
    }

    /**
     * Returns {@code true} when {@code @kind} names a read-only construct
     * (view, materializedView, storedProc, tableFunction).
     */
    public boolean isReadOnly() {
        return READ_ONLY_KINDS.contains(getEffectiveKind());
    }

    /**
     * Returns {@code true} when this source is writable (i.e. not read-only).
     */
    public boolean isWritable() {
        return !isReadOnly();
    }

    /**
     * Returns the value of {@code @schema}, or {@code null} if absent.
     */
    public String getSchema() {
        return hasMetaAttr(ATTR_SCHEMA)
            ? getMetaAttr(ATTR_SCHEMA).getValueAsString()
            : null;
    }

    @Override
    public String toString() {
        return String.format("%s[%s:%s]{table=%s, kind=%s, role=%s}",
            getClass().getSimpleName(),
            getType(),
            getSubType(),
            getTableName(),
            getEffectiveKind(),
            getRole());
    }
}
