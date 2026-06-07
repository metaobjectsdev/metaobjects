package com.metaobjects.source;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * Relational-database source metadata ({@code source.rdb}).
 *
 * <p>Registers as a concrete subtype of {@link MetaSource} ({@code source.base}).
 * Inherits all four attrs ({@code @table}, {@code @kind}, {@code @role}, {@code @schema})
 * from the base type registration.</p>
 *
 * <p>Read-only-ness is derived from {@code @kind} via
 * {@link MetaSource#READ_ONLY_KINDS}: view / materializedView / storedProc /
 * tableFunction are read-only; table (the default) is writable.</p>
 */
public class RdbSource extends MetaSource {

    /** RDB source subtype constant. */
    public static final String SUBTYPE_RDB = "rdb";

    /**
     * FR-015: name of an {@code object.value} whose fields supply the call parameters
     * for a callable source ({@code @kind: storedProc / tableFunction}). Declared on
     * {@code source.rdb} (NOT the abstract base) to match the cross-port canonical.
     */
    public static final String ATTR_PARAMETER_REF = "parameterRef";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public RdbSource(String name) {
        super(SUBTYPE_RDB, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code source.rdb} subtype with the registry.
     * Called by {@link SourceTypesMetaDataProvider} after
     * {@link MetaSource#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(RdbSource.class, def -> {
            def.type(TYPE_SOURCE).subType(SUBTYPE_RDB)
               .description("Relational-database source — table, view, materialised view, stored proc, or table-valued function")
               .inheritsFrom(TYPE_SOURCE, SUBTYPE_BASE);

            // SP-G Unit 6a: the physical / structural source attrs live on source.rdb
            // (NOT the abstract source.base) — matching the cross-port canonical.

            // @table — physical SQL table name for @kind: "table" (default).
            // FR-016: one of five kind-aware physical-name aliases; all write to
            // the same internal slot. Pre-1.0 legacy: also accepted with non-table
            // @kind (canonical-serializer rewrites; loader emits
            // WARN_LEGACY_PHYSICAL_NAME_ALIAS).
            def.optionalAttributeWithConstraints(ATTR_TABLE)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @view — physical SQL view name for @kind: "view" (FR-016 / ADR-0018).
            def.optionalAttributeWithConstraints(ATTR_VIEW)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @materializedView — physical SQL materialized-view name for
            // @kind: "materializedView" (FR-016 / ADR-0018).
            def.optionalAttributeWithConstraints(ATTR_MATERIALIZED_VIEW)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @proc — physical SQL stored-procedure name for @kind: "storedProc".
            def.optionalAttributeWithConstraints(ATTR_PROC)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @function — physical SQL table-function name for @kind: "tableFunction".
            def.optionalAttributeWithConstraints(ATTR_FUNCTION)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // @kind — enum-constrained; withEnum also marks it as single.
            def.optionalAttributeWithConstraints(ATTR_KIND)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(KIND_TABLE, KIND_VIEW, KIND_MATERIALIZED_VIEW,
                         KIND_STORED_PROC, KIND_TABLE_FUNCTION);

            // @role — enum-constrained; withEnum also marks it as single.
            def.optionalAttributeWithConstraints(ATTR_ROLE)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(ROLE_PRIMARY, ROLE_REPLICA, ROLE_INDEX,
                         ROLE_CACHE, ROLE_PUBLISH, ROLE_MIRROR);

            // @schema — optional, string, single value.
            def.optionalAttributeWithConstraints(ATTR_SCHEMA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();

            // FR-015: @parameterRef — call-parameters reference for callable sources.
            def.optionalAttributeWithConstraints(ATTR_PARAMETER_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}
