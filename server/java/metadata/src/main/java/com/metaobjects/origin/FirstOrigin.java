package com.metaobjects.origin;

import com.metaobjects.attr.FilterAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * First origin ({@code origin.first}) — the single related row selected by
 * {@code @orderBy} along {@code @via}, projecting its {@code @of} column (argmax
 * then project). Latest = {@code @orderBy} desc (#195).
 *
 * <p>Carries {@code @of} (required) + {@code @orderBy} (required, array) plus
 * {@code @via} (optional) and {@code @filter} (optional scoping predicate).
 * Read-only; an empty related set (after {@code @filter}) → null, so the field must
 * not be {@code @required}. Path/type semantics are enforced in
 * {@code ValidationPhase}.</p>
 */
public class FirstOrigin extends MetaOrigin {

    /** First origin subtype constant. */
    public static final String SUBTYPE_FIRST = "first";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public FirstOrigin(String name) {
        super(SUBTYPE_FIRST, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code origin.first} subtype with the registry.
     * Called by {@link OriginTypesMetaDataProvider} after
     * {@link MetaOrigin#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(FirstOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_FIRST)
               .description("First origin — one related row selected by @orderBy along @via, projecting its @of column")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);

            // #195: first carries @of (required) + @orderBy (required, array) +
            // @via (optional) + @filter (optional). @via single-hop-unique inference
            // + the deterministic PK tie-breaker live in ValidationPhase.
            def.requiredAttributeWithConstraints(ATTR_OF)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.optionalAttributeWithConstraints(ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            def.requiredAttributeWithConstraints(ATTR_ORDER_BY)
               .ofType(StringAttribute.SUBTYPE_STRING).asArray();
            def.optionalAttributeWithConstraints(ATTR_FILTER)
               .ofType(FilterAttribute.SUBTYPE_FILTER).asSingle();
        });
    }
}
