package com.metaobjects.origin;

import com.metaobjects.registry.MetaDataRegistry;

/**
 * Aggregate origin ({@code origin.aggregate}) — the field's value is computed by
 * aggregating values over a relationship path (count / sum / avg / min / max).
 *
 * <p>Carries {@code @agg}, {@code @of}, and {@code @via} (all required). Attrs
 * are inherited from {@link MetaOrigin#registerTypes(MetaDataRegistry)}; the
 * required-checks are enforced in {@code ValidationPhase}.</p>
 */
public class AggregateOrigin extends MetaOrigin {

    /** Aggregate origin subtype constant. */
    public static final String SUBTYPE_AGGREGATE = "aggregate";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public AggregateOrigin(String name) {
        super(SUBTYPE_AGGREGATE, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code origin.aggregate} subtype with the registry.
     * Called by {@link OriginTypesMetaDataProvider} after
     * {@link MetaOrigin#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(AggregateOrigin.class, def -> def
            .type(TYPE_ORIGIN).subType(SUBTYPE_AGGREGATE)
            .description("Aggregate origin — field value computed by aggregating over a relationship path (count/sum/avg/min/max)")
            .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE)
        );
    }
}
