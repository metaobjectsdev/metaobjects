package com.metaobjects.database;

import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/**
 * Core database MetaData type provider.
 *
 * <p>Historically this provider registered a parallel <em>physical</em> {@code db*}
 * attribute vocabulary on every field / object / identity type. As of SP-G Phase 2
 * Unit 7 that vocabulary has been converged onto the cross-port <em>logical</em>
 * attrs that {@link com.metaobjects.field.MetaField} already declares on
 * {@code field.base} — {@code column}, {@code dbColumnType}, {@code db.indexed},
 * {@code maxLength}, {@code precision}, {@code scale}, {@code unique} (+ nullability
 * derived from {@code required}). Owned-object storage shape is expressed via
 * {@code field.object @storage} ({@code flattened} / {@code jsonb} / {@code subdocument}).</p>
 *
 * <p>The DDL/migration-only remnants ({@code dbForeignKey}, {@code previousName},
 * {@code dbIndexName}, {@code dbSequenceName}, {@code dbTablespace}) are dead under
 * ADR-0015 (schema migrations are TypeScript-owned; OMDB is pure data-access) and
 * were removed — they had no live runtime consumer.</p>
 *
 * <p>This provider therefore no longer registers any field/object/identity attrs.
 * It is retained only as the home of the {@code @dbColumnType} value vocabulary
 * (the physical column-type escape hatch, ADR-0013) consumed by OMDB + the codegens,
 * keeping that closed value set in one cross-language place.</p>
 *
 * Priority: 150 (after core types, before code generation)
 */
public class CoreDBMetaDataProvider implements MetaDataTypeProvider {

    /**
     * Field physical column name. Source-v2 Tier-1 cross-language vocabulary
     * (matches the TS reference and the shared conformance corpus).
     *
     * <p>Paradigm-neutral key (no {@code db} prefix) to pair with
     * {@code source.rdb @table}: a future {@code source.docdb} would still use
     * {@code @column} for the physical name.</p>
     *
     * <p>Registered on {@code field.base} by {@link com.metaobjects.field.MetaField}
     * ({@code ATTR_COLUMN}); kept here as the cross-port constant the persistence +
     * codegen consumers reference.</p>
     */
    public static final String COLUMN = "column";

    /**
     * Physical column-type attribute (R6 Plan 2b, ADR-0013). Selects the DB column type
     * while leaving the logical field type and its idiomatic native binding untouched —
     * the canonical <em>physical</em> escape hatch for DB-specific column types.
     *
     * <p>Registered on {@code field.base} by {@link com.metaobjects.field.MetaField}
     * ({@code ATTR_DB_COLUMN_TYPE}). Closed value set ({@link #VALID_DB_COLUMN_TYPES});
     * each value is legal only on a specific logical field subtype (validated own-only
     * by the loader, emitting {@code ERR_BAD_ATTR_VALUE} for an illegal pairing or
     * unrecognized value):</p>
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

    /**
     * The closed set of legal {@code @dbColumnType} values.
     *
     * <p><b>dbColumnType slim-and-derive — Phase 1.</b> The native-array values
     * {@code uuid_array} / {@code text_array} were removed: a Postgres {@code uuid[]} /
     * {@code text[]} column is now <em>derived</em> from {@code field.uuid} / {@code field.string}
     * + {@code isArray:true} (the metadata already says it — ADR-0023), never declared. The
     * vestigial {@code text} value was never carried here (a no-{@code maxLength}
     * {@code field.string} already defaults to a {@code text} column). This value-set is shared
     * with the Kotlin port via this JVM provider.</p>
     */
    public static final java.util.List<String> VALID_DB_COLUMN_TYPES = java.util.List.of(
        DB_COLUMN_TYPE_UUID, DB_COLUMN_TYPE_JSONB, DB_COLUMN_TYPE_TIMESTAMP_TZ);

    @Override
    public String getProviderId() {
        return "database-extensions";
    }

    @Override
    public String[] getDependencies() {
        // Depends on field types, object types, and identity types so it loads after them.
        return new String[]{"field-types", "object-types", "identity-types"};
    }

    @Override
    public void registerTypes(MetaDataRegistry registry) {
        // No attrs to register: the cross-port logical field attrs (column,
        // dbColumnType, db.indexed, maxLength, precision, scale, unique, storage)
        // are declared on field.base by MetaField (SP-G Unit 4), and the legacy
        // physical db* vocabulary was converged/dropped in SP-G Unit 7.
    }

    @Override
    public String getDescription() {
        return "Database MetaData Provider - cross-port @dbColumnType value vocabulary";
    }
}
