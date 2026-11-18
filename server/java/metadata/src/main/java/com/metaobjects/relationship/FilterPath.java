package com.metaobjects.relationship;

import com.metaobjects.MetaData;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.loader.References;
import com.metaobjects.object.MetaObject;

import java.util.List;

/**
 * A projection {@code @filter} key may be a PATH: to-one hops from the base entity, then a field
 * of the entity they reach ({@code caseId.status}, {@code orderId.customerId.isActive}). A hop is
 * an {@code identity.reference} (a forward FK) or a relationship with {@code @cardinality one},
 * named as an origin {@code @via} names its hops. A to-many hop would multiply the base rows, so
 * it is refused. One resolver for the loader and the view lowering. Mirrors TS
 * {@code filter-path.ts} / C# {@code FilterPath}.
 *
 * @param hops   the hop names walked
 * @param entity the entity reached
 * @param field  its field
 */
public record FilterPath(List<String> hops, MetaObject entity, MetaField<?> field) {

    /** The outcome of {@link #resolve}: a path, or the reason it does not resolve. */
    public record Result(FilterPath path, String error) { }

    /**
     * Resolve a dotted filter key against {@code base}. {@code null} when {@code key} has no dot
     * (a plain field name, resolved by the caller); a {@link Result} carrying the failure when a
     * hop or the field does not resolve.
     */
    public static Result resolve(MetaObject base, String key) {
        String[] segments = key.split("\\.", -1);
        if (segments.length < 2) return null;
        List<String> hops = List.of(segments).subList(0, segments.length - 1);
        String fieldName = segments[segments.length - 1];
        MetaObject current = base;
        for (String hop : hops) {
            Object next = toOneHop(current, hop);
            if (next instanceof String error) return new Result(null, error);
            current = (MetaObject) next;
        }
        // ADR-0039: resolving — the reached field may be inherited.
        for (MetaData c : current.getChildren(MetaData.class, true)) {
            if (c instanceof MetaField && fieldName.equals(c.getShortName())) {
                return new Result(new FilterPath(List.copyOf(hops), current, (MetaField<?>) c), null);
            }
        }
        return new Result(null, "\"" + current.getShortName() + "\" declares no field \"" + fieldName + "\"");
    }

    /** The target of one to-one hop from {@code obj}, or a String saying why there is none. */
    private static Object toOneHop(MetaObject obj, String hop) {
        // ADR-0039: resolving — a hop may be inherited through extends.
        for (MetaData c : obj.getChildren(MetaData.class, true)) {
            if (c instanceof MetaIdentity && MetaIdentity.SUBTYPE_REFERENCE.equals(c.getSubType())
                    && hop.equals(c.getShortName())) {
                MetaObject target = References.refTarget(c, MetaIdentity.ATTR_REFERENCES);
                return target != null ? target
                    : "reference \"" + obj.getShortName() + "." + hop + "\" does not resolve";
            }
        }
        for (MetaData c : obj.getChildren(MetaData.class, true)) {
            if (c instanceof MetaRelationship && hop.equals(c.getShortName())) {
                String cardinality = c.hasMetaAttr(MetaRelationship.ATTR_CARDINALITY, true)
                    ? c.getMetaAttr(MetaRelationship.ATTR_CARDINALITY, true).getValueAsString() : null;
                if (!MetaRelationship.CARDINALITY_ONE.equals(cardinality)) {
                    return "\"" + obj.getShortName() + "." + hop + "\" is to-many; a filter path may only walk to-one hops";
                }
                MetaObject target = References.refTarget(c, MetaRelationship.ATTR_OBJECT_REF);
                return target != null ? target
                    : "relationship \"" + obj.getShortName() + "." + hop + "\" does not resolve";
            }
        }
        return "\"" + obj.getShortName() + "\" declares no identity.reference or to-one relationship named \"" + hop + "\"";
    }
}
