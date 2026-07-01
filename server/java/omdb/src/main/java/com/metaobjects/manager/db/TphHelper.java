package com.metaobjects.manager.db;

import com.metaobjects.object.MetaObject;

/**
 * FR-017 — table-per-hierarchy (TPH) discriminator resolution for the OMDB runtime.
 *
 * <p>A TPH SUBTYPE is an entity that declares {@code @discriminatorValue} and
 * {@code extends} (transitively) a base that declares {@code @discriminator}. The
 * {@link ObjectManagerDB} uses this to:</p>
 * <ul>
 *   <li>inject the discriminator value on create (the entity names the subtype; the
 *       caller never sets it);</li>
 *   <li>scope every read/count/delete to the subtype (a row of a different subtype
 *       is invisible), mirroring the generated per-subtype route's cross-subtype 404;</li>
 *   <li>treat the discriminator as immutable.</li>
 * </ul>
 *
 * <p>The discriminator FIELD name lives on the base ({@code @discriminator}); the
 * VALUE lives on the subtype ({@code @discriminatorValue}). For deep hierarchies the
 * base may be any ancestor, so we walk the resolved super chain to find it.</p>
 *
 * <p>Mirrors the TS reference {@code runtime-ts/src/tph.ts} and the Python
 * {@code runtime/tph.py}.</p>
 */
public final class TphHelper {

    private TphHelper() {}

    /** The discriminator field NAME + this subtype's discriminator VALUE. */
    public record TphSubtype(String field, String value) {}

    /**
     * If {@code entity} is a TPH subtype, return its discriminator field + value;
     * else {@code null}. A subtype declares {@code @discriminatorValue} (own attr)
     * and inherits {@code @discriminator} from an ancestor in its resolved super chain.
     */
    public static TphSubtype tphSubtypeOf(MetaObject entity) {
        // ADR-0039: @discriminatorValue is declaration-layer — each subtype declares its
        // own; never inherited. @discriminator is located by an explicit super-resolution
        // walk (below), reading own-only on each hop. Both KEPT own-only.
        if (entity == null || !entity.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false)) {
            return null; // not a subtype (no own @discriminatorValue)
        }
        String value = entity.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR_VALUE, false).getValueAsString();

        for (MetaObject ancestor = entity.getSuperObject(); ancestor != null; ancestor = ancestor.getSuperObject()) {
            if (ancestor.hasMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false)) {
                String field = ancestor.getMetaAttr(MetaObject.ATTR_DISCRIMINATOR, false).getValueAsString();
                return new TphSubtype(field, value);
            }
        }
        return null;
    }
}
