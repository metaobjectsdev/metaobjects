package com.metaobjects.render.extract;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Null-safe coercions from a ExtractionOutcome data map onto typed record components. Generated extractLenient(...) calls these. */
public final class ExtractMap {
    private ExtractMap() {}

    public static String asString(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v == null ? null : (v instanceof String s ? s : String.valueOf(v));
    }

    public static Integer asInt(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.intValue() : null;
    }

    public static Long asLong(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.longValue() : null;
    }

    public static Double asDouble(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Number n ? n.doubleValue() : null;
    }

    public static Boolean asBool(Map<String, Object> d, String k) {
        Object v = d.get(k);
        return v instanceof Boolean b ? b : null;
    }

    public static List<String> asStringList(Map<String, Object> d, String k) {
        Object v = d.get(k);
        if (!(v instanceof List<?> list)) return null;
        List<String> out = new ArrayList<>(list.size());
        for (Object e : list) out.add(e == null ? null : String.valueOf(e));
        return out;
    }
}
