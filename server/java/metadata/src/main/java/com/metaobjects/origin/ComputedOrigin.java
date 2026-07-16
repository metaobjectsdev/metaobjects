package com.metaobjects.origin;

import com.metaobjects.attr.ExpressionAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * Computed origin ({@code origin.computed}) — a row-level value computed from the
 * base entity's own fields via a structured expression tree ({@code @expr}). No
 * related rows, no {@code @via} (#195).
 *
 * <p>Carries {@code @expr} (required): the {@code attr.expression} tree. Read-only;
 * the expression's inferred root type must equal the field's declared subType
 * ({@code ERR_COMPUTED_TYPE_MISMATCH}) — enforced in {@code ValidationPhase}.</p>
 */
public class ComputedOrigin extends MetaOrigin {

    /** Computed origin subtype constant. */
    public static final String SUBTYPE_COMPUTED = "computed";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public ComputedOrigin(String name) {
        super(SUBTYPE_COMPUTED, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code origin.computed} subtype with the registry.
     * Called by {@link OriginTypesMetaDataProvider} after
     * {@link MetaOrigin#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(ComputedOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_COMPUTED)
               .description("Computed origin — row-level value computed from the base entity's own fields via an expression tree")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);

            // #195: computed carries ONLY @expr (required, object-valued expression
            // tree). Type-agreement (inferred root type == field subType) is
            // re-validated in ValidationPhase#validateOrigins.
            def.requiredAttributeWithConstraints(ATTR_EXPR)
               .ofType(ExpressionAttribute.SUBTYPE_EXPRESSION).asSingle();
        });
    }
}
