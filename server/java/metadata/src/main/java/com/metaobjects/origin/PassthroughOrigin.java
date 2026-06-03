package com.metaobjects.origin;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * Passthrough origin ({@code origin.passthrough}) — the field's value is sourced
 * directly from a cross-entity field reference (e.g. a projection that forwards
 * {@code Program.title}).
 *
 * <p>Carries {@code @from} (required): the dotted Entity.field reference
 * identifying the source value. Carries {@code @via} (optional): the dotted
 * relationship path to reach the source entity. Attrs are inherited from
 * {@link MetaOrigin#registerTypes(MetaDataRegistry)}; the required-check on
 * {@code @from} is enforced in {@code ValidationPhase}.</p>
 */
public class PassthroughOrigin extends MetaOrigin {

    /** Passthrough origin subtype constant. */
    public static final String SUBTYPE_PASSTHROUGH = "passthrough";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public PassthroughOrigin(String name) {
        super(SUBTYPE_PASSTHROUGH, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code origin.passthrough} subtype with the registry.
     * Called by {@link OriginTypesMetaDataProvider} after
     * {@link MetaOrigin#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PassthroughOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_PASSTHROUGH)
               .description("Passthrough origin — field value sourced directly from a cross-entity field reference")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);

            // SP-G Unit 6a: passthrough carries @from (required) + @via (optional) —
            // cross-port canonical. Path semantics re-validated in
            // ValidationPhase#validateOrigins.
            def.requiredAttributeWithConstraints(ATTR_FROM)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}
