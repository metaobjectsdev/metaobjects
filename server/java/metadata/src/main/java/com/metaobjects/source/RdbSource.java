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

            // FR-015: @parameterRef — declared on the concrete rdb subtype (the
            // abstract source.base stays attr-free for the param concept).
            def.optionalAttributeWithConstraints(ATTR_PARAMETER_REF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}
