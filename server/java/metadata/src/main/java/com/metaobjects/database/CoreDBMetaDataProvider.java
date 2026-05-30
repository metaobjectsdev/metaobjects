package com.metaobjects.database;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.identity.SecondaryIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Core database MetaData type provider that registers common database attributes
 * used by both JPA code generation (mustache templates) and ObjectManagerDB.
 *
 * This provider registers database-related attributes that are shared across
 * database functionality rather than being specific to one implementation.
 *
 * Priority: 150 (after core types, before code generation)
 */
public class CoreDBMetaDataProvider implements MetaDataTypeProvider {

    // Common database attribute constants
    //
    // Source-v2 ADR-0007: the object-level {@code @dbTable} / {@code @dbView} attrs
    // were dropped in Stage 2. An object declares storage ONLY via {@code source.*}
    // children — the primary writable {@code source.rdb} child's {@code @table}
    // attr is the table name; a read-only ({@code @kind: view / ...}) source
    // names the view. See {@link com.metaobjects.object.MetaObject#getPrimaryRdbTableName()}.

    /**
     * Field physical column name. Source-v2 Tier-1 cross-language vocabulary
     * (matches the TS reference and the shared conformance corpus).
     *
     * <p>Paradigm-neutral key (no {@code db} prefix) to pair with
     * {@code source.rdb @table}: a future {@code source.docdb} would still use
     * {@code @column} for the physical name. Prior to source-v2 this attr was
     * {@code @dbColumn}; no backwards-compat alias.</p>
     */
    public static final String COLUMN = "column";
    public static final String DB_NULLABLE = "dbNullable";
    public static final String DB_PRIMARY_KEY = "dbPrimaryKey";
    public static final String DB_FOREIGN_KEY = "dbForeignKey";
    public static final String DB_INDEX = "dbIndex";
    public static final String DB_UNIQUE = "dbUnique";
    public static final String DB_LENGTH = "dbLength";
    public static final String DB_PRECISION = "dbPrecision";
    public static final String DB_SCALE = "dbScale";
    public static final String DB_AUTO_INCREMENT = "dbAutoIncrement";
    public static final String DB_TYPE = "dbType";

    /** {@code @dbType} value that marks a field as a JSON document column. */
    public static final String DB_TYPE_JSONB = "jsonb";

    /**
     * Physical column-type attribute (R6 Plan 2b, ADR-0013). Selects the DB column type
     * while leaving the logical field type and its idiomatic native binding untouched —
     * the canonical <em>physical</em> escape hatch for DB-specific column types.
     *
     * <p>Closed value set ({@link #VALID_DB_COLUMN_TYPES}); each value is legal only on a
     * specific logical field subtype (validated own-only by the loader, emitting
     * {@code ERR_BAD_ATTR_VALUE} for an illegal pairing or unrecognized value):</p>
     * <ul>
     *   <li>{@code uuid} → {@code field.string} → Postgres {@code UUID} column.</li>
     *   <li>{@code jsonb} → {@code field.string} → Postgres {@code JSONB} (genuinely-open JSON).</li>
     *   <li>{@code timestamp_with_tz} → {@code field.timestamp} → {@code TIMESTAMP WITH TIME ZONE}.</li>
     * </ul>
     */
    public static final String DB_COLUMN_TYPE = "dbColumnType";

    /** {@code @dbColumnType} value → Postgres native {@code uuid} column (on {@code field.string}). */
    public static final String DB_COLUMN_TYPE_UUID = "uuid";
    /** {@code @dbColumnType} value → Postgres native {@code jsonb} column (on {@code field.string}). */
    public static final String DB_COLUMN_TYPE_JSONB = "jsonb";
    /** {@code @dbColumnType} value → {@code timestamp with time zone} column (on {@code field.timestamp}). */
    public static final String DB_COLUMN_TYPE_TIMESTAMP_TZ = "timestamp_with_tz";

    /** The closed set of legal {@code @dbColumnType} values. */
    public static final java.util.List<String> VALID_DB_COLUMN_TYPES = java.util.List.of(
        DB_COLUMN_TYPE_UUID, DB_COLUMN_TYPE_JSONB, DB_COLUMN_TYPE_TIMESTAMP_TZ);

    // Identity-specific database attributes
    public static final String DB_SEQUENCE_NAME = "dbSequenceName";
    public static final String DB_INDEX_NAME = "dbIndexName";
    public static final String DB_TABLESPACE = "dbTablespace";

    /** Rename hint: the prior name of this object/field, so migration emits RENAME (not drop+add). */
    public static final String PREVIOUS_NAME = "previousName";

    @Override
    public String getProviderId() {
        return "database-extensions";
    }

    @Override
    public String[] getDependencies() {
        // Depends on field types, object types, and identity types for extending them
        return new String[]{"field-types", "object-types", "identity-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        registerDatabaseAttributes(registry);
    }

    @Override
    public String getDescription() {
        return "Database MetaData Provider - Common database attributes for JPA and ObjectManager";
    }

    /**
     * Registers common database attributes used by both JPA code generation
     * and ObjectManagerDB implementations.
     */
    public static void registerDatabaseAttributes(MetaDataRegistry registry) {
        // Object-level database attributes
        //
        // Source-v2 ADR-0007: {@code @dbTable} / {@code @dbView} are NOT registered here.
        // The table/view name is declared on {@code source.rdb @table}; see
        // {@link com.metaobjects.object.MetaObject#getPrimaryRdbTableName()}.
        registry.findType(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_BASE)
            .optionalAttribute(DB_INDEX, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_UNIQUE, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(PREVIOUS_NAME, StringAttribute.SUBTYPE_STRING);

        // Field-level database attributes
        registry.findType(MetaField.TYPE_FIELD, MetaField.SUBTYPE_BASE)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_NULLABLE, BooleanAttribute.SUBTYPE_BOOLEAN)
            .optionalAttribute(DB_FOREIGN_KEY, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_INDEX, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_UNIQUE, BooleanAttribute.SUBTYPE_BOOLEAN)
            .optionalAttribute(DB_LENGTH, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(DB_PRECISION, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(DB_SCALE, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(DB_TYPE, StringAttribute.SUBTYPE_STRING)
            // R6 Plan 2b: physical column-type escape hatch (validated own-only by the loader).
            .optionalAttribute(DB_COLUMN_TYPE, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(PREVIOUS_NAME, StringAttribute.SUBTYPE_STRING);

        // String field specific
        registry.findType(MetaField.TYPE_FIELD, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_LENGTH, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(DB_COLUMN_TYPE, StringAttribute.SUBTYPE_STRING);

        // UUID field specific (R6 Plan 2a): @column override, like the other scalars.
        registry.findType(MetaField.TYPE_FIELD, com.metaobjects.field.UuidField.SUBTYPE_UUID)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING);

        // Numeric field specific
        registry.findType(MetaField.TYPE_FIELD, LongField.SUBTYPE_LONG)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING);

        registry.findType(MetaField.TYPE_FIELD, IntegerField.SUBTYPE_INT)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING);

        registry.findType(MetaField.TYPE_FIELD, DoubleField.SUBTYPE_DOUBLE)
            .optionalAttribute(COLUMN, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_PRECISION, IntAttribute.SUBTYPE_INT)
            .optionalAttribute(DB_SCALE, IntAttribute.SUBTYPE_INT);

        // Identity-level database attributes (replaces deprecated key attributes)
        registry.findType(MetaIdentity.TYPE_IDENTITY, PrimaryIdentity.SUBTYPE_PRIMARY)
            .optionalAttribute(DB_SEQUENCE_NAME, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_INDEX_NAME, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_TABLESPACE, StringAttribute.SUBTYPE_STRING);

        registry.findType(MetaIdentity.TYPE_IDENTITY, SecondaryIdentity.SUBTYPE_SECONDARY)
            .optionalAttribute(DB_INDEX_NAME, StringAttribute.SUBTYPE_STRING)
            .optionalAttribute(DB_TABLESPACE, StringAttribute.SUBTYPE_STRING);
    }
}