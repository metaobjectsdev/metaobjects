package com.metaobjects.source;

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
        registry.registerType(RdbSource.class, def -> def
            .type(TYPE_SOURCE).subType(SUBTYPE_RDB)
            .description("Relational-database source — table, view, materialised view, stored proc, or table-valued function")
            .inheritsFrom(TYPE_SOURCE, SUBTYPE_BASE)
        );
    }
}
