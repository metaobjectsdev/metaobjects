package com.metaobjects.origin;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * Aggregate origin ({@code origin.aggregate}) — a value reduced from the related
 * row-set: count / sum / avg / min / max over {@code @of}; any / all predicate
 * quantifiers over {@code @filter}; or collect (an array rollup of {@code @of}).
 *
 * <p>Carries {@code @agg} (required, enum-constrained) plus {@code @of} /
 * {@code @via} / {@code @filter} / {@code @distinct} / {@code @orderBy} (optional
 * at the type level). The per-{@code @agg} presence rules + path semantics are
 * enforced in {@code ValidationPhase}.</p>
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
        registry.registerType(AggregateOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_AGGREGATE)
               .description("Aggregate origin — field value computed by aggregating over a relationship path (count/sum/avg/min/max)")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);

            // #195: aggregate carries @agg (required, enum-constrained) + @of / @via /
            // @filter / @distinct / @orderBy (all optional). Path semantics + the
            // per-@agg required-ness (of required for count/…/collect, forbidden for
            // any/all; filter required for any/all; distinct/orderBy collect-only) are
            // re-validated in ValidationPhase#validateOrigins.
            // FR-024 (ADR-0029): @via inferable when exactly one single-hop
            // relationship reaches the @of entity (single-hop-unique inference).
            def.requiredAttributeWithConstraints(ATTR_AGG)
               .ofType(StringAttribute.SUBTYPE_STRING)
               .withEnum(AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX,
                         AGG_ANY, AGG_ALL, AGG_COLLECT);
            // @of optional at the type level (#195: forbidden for any/all — the
            // per-@agg presence rule lives in ValidationPhase).
            def.optionalAttributeWithConstraints(ATTR_OF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            // Optional scoping filter (attr.filter object) → SQL FILTER (WHERE ...).
            def.optionalAttributeWithConstraints(ATTR_FILTER)
               .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
            // #195 collect support: @distinct (dedupe) + @orderBy (element order).
            def.optionalAttributeWithConstraints(ATTR_DISTINCT)
               .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle();
            def.optionalAttributeWithConstraints(ATTR_ORDER_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
        });
    }
}
