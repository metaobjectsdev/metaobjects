package com.metaobjects.origin;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/**
 * Collection origin ({@code origin.collection}) — the (array) field's value is a
 * relationship-derived array of nested view-objects (FR-004 R4).
 *
 * <p>Carries {@code @via} (required): the dotted relationship path the collection
 * walks (e.g. {@code "Author.posts"}), or a wildcard-prefixed selector for a
 * package-spanning collection (e.g. {@code "*.User"}). Attrs are inherited from
 * {@link MetaOrigin#registerTypes(MetaDataRegistry)}; the required-check on
 * {@code @via} is enforced in {@code ValidationPhase}.</p>
 */
public class CollectionOrigin extends MetaOrigin {

    /** Collection origin subtype constant. */
    public static final String SUBTYPE_COLLECTION = "collection";

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public CollectionOrigin(String name) {
        super(SUBTYPE_COLLECTION, name);
    }

    // -----------------------------------------------------------------------
    // Type registration
    // -----------------------------------------------------------------------

    /**
     * Register the concrete {@code origin.collection} subtype with the registry.
     * Called by {@link OriginTypesMetaDataProvider} after
     * {@link MetaOrigin#registerTypes(MetaDataRegistry)}.
     */
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(CollectionOrigin.class, def -> {
            def.type(TYPE_ORIGIN).subType(SUBTYPE_COLLECTION)
               .description("Collection origin — relationship-derived array of nested view-objects (FR-004 R4)")
               .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE);

            // SP-G Unit 6a: collection carries ONLY @via (required) — cross-port canonical.
            def.requiredAttributeWithConstraints(ATTR_VIA)
               .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }
}
