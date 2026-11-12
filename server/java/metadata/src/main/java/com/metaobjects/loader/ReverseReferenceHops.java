package com.metaobjects.loader;

import com.metaobjects.MetaData;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.object.CollectionNames;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;

/**
 * A {@code @via} hop may walk an {@code identity.reference} BACKWARDS, from the entity it
 * targets to the entity that declares it, with no relationship declared for it. The hop is
 * named by the declaring entity's collection name, lowerFirst ({@code Patient.consents} for
 * {@code Consent.patient}). Mirrors TS {@code findReverseReferenceHops} / C#
 * {@code ReverseReferenceHops}; the loader corpus fixtures
 * {@code origin-reverse-reference-hop} and {@code error-origin-reverse-hop-ambiguous} pin the rule.
 */
public final class ReverseReferenceHops {

    private ReverseReferenceHops() {}

    /** A reverse hop: the object that declares the reference, and the reference walked backwards. */
    public record Hop(MetaObject holder, MetaIdentity reference) { }

    /** The name a reverse hop onto {@code holder}'s references takes: its collection name, lowerFirst. */
    public static String hopName(MetaObject holder) {
        String plural = CollectionNames.of(holder);
        return plural == null || plural.isEmpty() ? plural
            : Character.toLowerCase(plural.charAt(0)) + plural.substring(1);
    }

    /**
     * Every {@code identity.reference} that targets {@code target} from a concrete object whose
     * {@link #hopName} is {@code hopName}. One is the hop; none means the hop is not a reverse;
     * more than one is ambiguous. A declared relationship or reference of the same name on the
     * target always wins; callers look those up first.
     */
    public static List<Hop> find(MetaObject target, String hopName, List<MetaObject> objects) {
        List<Hop> found = new ArrayList<>();
        for (MetaObject holder : objects) {
            if (isAbstract(holder) || !hopName.equals(hopName(holder))) continue;
            // ADR-0039: resolving — a reference may be inherited through extends.
            for (MetaData c : holder.getChildren(MetaData.class, true)) {
                if (!(c instanceof MetaIdentity) || !MetaIdentity.SUBTYPE_REFERENCE.equals(c.getSubType())) continue;
                // ADR-0059 R7: compare the bound target, never a short name.
                if (References.refTarget(c, MetaIdentity.ATTR_REFERENCES) == target) {
                    found.add(new Hop(holder, (MetaIdentity) c));
                }
            }
        }
        return found;
    }

    private static boolean isAbstract(MetaData node) {
        // ADR-0039: own — abstractness is a declaration-layer marker.
        if (!node.hasMetaAttr(MetaData.ATTR_IS_ABSTRACT, false)) return false;
        Object v = node.getMetaAttr(MetaData.ATTR_IS_ABSTRACT, false).getValue();
        return v instanceof Boolean ? (Boolean) v : v instanceof String && "true".equalsIgnoreCase((String) v);
    }
}
