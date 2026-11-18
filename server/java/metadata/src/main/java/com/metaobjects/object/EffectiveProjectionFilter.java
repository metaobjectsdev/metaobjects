package com.metaobjects.object;

import com.metaobjects.MetaData;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A projection's EFFECTIVE row scope. {@code @filter} composes down an {@code extends} chain
 * rather than overriding: a projection that extends a filtered projection keeps the base's row
 * scope (a gate on an abstract base must survive in every extender). Every level's own
 * {@code @filter}, root-most first, ANDed. One reader for the loader and the view lowering.
 * Mirrors TS {@code effectiveProjectionFilter} / C# {@code EffectiveProjectionFilter}.
 */
public final class EffectiveProjectionFilter {

    private static final String AND = "and";

    private EffectiveProjectionFilter() {}

    /**
     * The {@code @filter} a projection's view applies: its own and every super's, root-most
     * first. One declaration is returned as declared; two or more are ANDed in one flat
     * {@code { and: [...] }}. {@code null} when no level declares one.
     */
    public static Object of(MetaData projection) {
        List<Object> levels = new ArrayList<>();
        Set<MetaData> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (MetaData node = projection; node != null && seen.add(node);
                node = node.hasSuperData() ? node.getSuperData() : null) {
            // ADR-0039: own — each level contributes the @filter declared on it; the resolving
            // read would return only the nearest one, which is the override this replaces.
            if (node.hasMetaAttr(MetaObject.ATTR_FILTER, false)) {
                levels.add(0, node.getMetaAttr(MetaObject.ATTR_FILTER, false).getValue());
            }
        }
        if (levels.isEmpty()) return null;
        if (levels.size() == 1) return levels.get(0);
        List<Object> members = new ArrayList<>();
        for (Object level : levels) members.addAll(andMembers(level));
        Map<String, Object> composed = new LinkedHashMap<>();
        composed.put(AND, members);
        return composed;
    }

    /** A level that is itself a bare {@code { and: [...] }} contributes its members, keeping the AND flat. */
    private static List<Object> andMembers(Object filter) {
        if (filter instanceof Map<?, ?> m && m.size() == 1 && m.get(AND) instanceof List<?> list) {
            return new ArrayList<>(list);
        }
        List<Object> one = new ArrayList<>();
        one.add(filter);
        return one;
    }
}
