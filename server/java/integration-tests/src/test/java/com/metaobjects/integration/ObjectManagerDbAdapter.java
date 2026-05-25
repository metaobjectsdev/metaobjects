package com.metaobjects.integration;

import com.metaobjects.field.MetaField;
import com.metaobjects.integration.Scenarios.QuerySpec;
import com.metaobjects.integration.Scenarios.SortSpec;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Translate a {@link QuerySpec} from the cross-port corpus DSL into a
 * {@link ObjectManagerDB} call ({@code getObjects} / {@code getObjectsCount}).
 *
 * <p>Mirrors the C# {@code DbContextAdapter} and the TS query-scenario
 * translator. ObjectManagerDB's API is method-based (not LINQ Expression-tree
 * shaped) so the translation is a straight DSL → {@link Expression} +
 * {@link QueryOptions} map.</p>
 */
final class ObjectManagerDbAdapter {

    private ObjectManagerDbAdapter() {}

    /**
     * Execute one {@link QuerySpec} against an open connection. Returns:
     * <ul>
     *   <li>{@code op:list}  → {@code List<Map<String,Object>>} of normalized rows</li>
     *   <li>{@code op:get}   → {@code Map<String,Object>} or {@code null}</li>
     *   <li>{@code op:count} → {@code Long}</li>
     * </ul>
     */
    static Object execute(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc, QuerySpec spec) throws Exception {
        Expression filter = buildFilter(spec.by(), spec.filter());

        if ("count".equals(spec.op())) {
            return omdb.getObjectsCount(conn, mc, filter);
        }

        QueryOptions opts = new QueryOptions();
        if (filter != null) opts.setExpression(filter);
        if (spec.sort() != null && !spec.sort().isEmpty()) opts.setSortOrder(buildSort(spec.sort()));
        if (spec.limit() != null) opts.setRange(buildRange(spec.offset(), spec.limit()));

        Collection<?> raw = omdb.getObjects(conn, mc, opts);
        List<Map<String, Object>> rows = new ArrayList<>(raw.size());
        for (Object o : raw) rows.add(toRowMap(mc, o));

        if ("get".equals(spec.op())) return rows.isEmpty() ? null : rows.get(0);
        return rows; // op:list
    }

    // -----------------------------------------------------------------------
    // Filter translation
    // -----------------------------------------------------------------------

    /**
     * Combine {@code by} (op:get shortcut) and {@code filter} into one
     * Expression tree. {@code by} maps field→value (each becomes an EQUAL
     * clause); {@code filter} understands the cross-port DSL plus the
     * top-level {@code and:} combinator.
     */
    private static Expression buildFilter(Map<String, Object> by, Map<String, Object> filter) {
        Expression acc = null;
        if (by != null) {
            for (Map.Entry<String, Object> e : by.entrySet()) acc = and(acc, new Expression(e.getKey(), e.getValue()));
        }
        if (filter != null) {
            Expression filterExp = compileFilter(filter);
            if (filterExp != null) acc = and(acc, filterExp);
        }
        return acc;
    }

    @SuppressWarnings("unchecked")
    private static Expression compileFilter(Map<String, Object> filter) {
        // Top-level `and: [filter, filter, ...]` combinator.
        Object andValue = filter.get("and");
        if (andValue instanceof List<?> list) {
            Expression combined = null;
            for (Object child : list) {
                Map<String, Object> childMap = asStringKeyedMap(child);
                if (childMap == null) {
                    throw new IllegalArgumentException("`and` list elements must be filter maps (got: " +
                        (child == null ? "null" : child.getClass().getSimpleName()) + ")");
                }
                combined = and(combined, compileFilter(childMap));
            }
            return combined;
        }

        Expression acc = null;
        for (Map.Entry<String, Object> e : filter.entrySet()) {
            Map<String, Object> ops = asStringKeyedMap(e.getValue());
            if (ops == null) {
                throw new IllegalArgumentException("filter for field '" + e.getKey() +
                    "' must be a {op:value} map (got: " +
                    (e.getValue() == null ? "null" : e.getValue().getClass().getSimpleName()) + ")");
            }
            for (Map.Entry<String, Object> op : ops.entrySet()) {
                acc = and(acc, buildOp(e.getKey(), op.getKey(), op.getValue()));
            }
        }
        return acc;
    }

    private static Expression buildOp(String field, String op, Object value) {
        return switch (op) {
            case "eq"     -> new Expression(field, value, Expression.EQUAL);
            case "ne"     -> new Expression(field, value, Expression.NOT_EQUAL);
            case "gt"     -> new Expression(field, value, Expression.GREATER);
            case "gte"    -> new Expression(field, value, Expression.EQUAL_GREATER);
            case "lt"     -> new Expression(field, value, Expression.LESSER);
            case "lte"    -> new Expression(field, value, Expression.EQUAL_LESSER);
            case "isNull" -> {
                boolean wantNull = value instanceof Boolean b ? b
                    : value instanceof String s ? Boolean.parseBoolean(s) : false;
                // Expression(field, null, EQUAL|NOT_EQUAL) is the Java convention for IS NULL / IS NOT NULL.
                yield new Expression(field, null, wantNull ? Expression.EQUAL : Expression.NOT_EQUAL);
            }
            case "in"     -> compileIn(field, value);
            case "like"   -> compileLike(field, value);
            default       -> throw new IllegalArgumentException("Unsupported filter op '" + op + "' on field '" + field + "'");
        };
    }

    /**
     * Java's Expression has no native IN — compose as OR'd EQUALs. Order
     * is whatever the iteration order of the list gives; the SQL renderer
     * still produces a logically-equivalent WHERE clause.
     */
    private static Expression compileIn(String field, Object value) {
        if (!(value instanceof List<?> list) || list.isEmpty())
            throw new IllegalArgumentException("`in` op on field '" + field + "' requires a non-empty list");
        Expression acc = null;
        for (Object v : list) {
            Expression eq = new Expression(field, v, Expression.EQUAL);
            acc = acc == null ? eq : acc.or(eq);
        }
        return acc;
    }

    /**
     * Translate the cross-port {@code like} pattern (raw SQL LIKE, with the
     * user supplying {@code %}) into Java's positional CONTAIN/START_WITH/
     * END_WITH operator. Strips the {@code %} markers because Java's SQL
     * renderer re-adds them per operator (see GenericSQLDriver).
     */
    private static Expression compileLike(String field, Object value) {
        if (!(value instanceof String pattern))
            throw new IllegalArgumentException("`like` op on field '" + field + "' requires a string value");
        boolean prefix = pattern.startsWith("%");
        boolean suffix = pattern.endsWith("%");
        String core = pattern;
        if (suffix) core = core.substring(0, core.length() - 1);
        if (prefix) core = core.substring(1);
        if (prefix && suffix) return new Expression(field, core, Expression.CONTAIN);
        if (prefix)           return new Expression(field, core, Expression.END_WITH);
        if (suffix)           return new Expression(field, core, Expression.START_WITH);
        return new Expression(field, core, Expression.EQUAL);
    }

    private static Expression and(Expression a, Expression b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.and(b);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asStringKeyedMap(Object raw) {
        if (raw instanceof Map<?, ?> m) {
            Map<String, Object> out = new LinkedHashMap<>(m.size());
            for (Map.Entry<?, ?> e : m.entrySet()) out.put(String.valueOf(e.getKey()), e.getValue());
            return out;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Sort + Range
    // -----------------------------------------------------------------------

    /** Chain SortSpecs via {@link SortOrder#addNextSort(SortOrder)} into a linked list. */
    private static SortOrder buildSort(List<SortSpec> sorts) {
        SortOrder head = null;
        for (SortSpec s : sorts) {
            int dir = "desc".equalsIgnoreCase(s.dir()) ? SortOrder.DESC : SortOrder.ASC;
            SortOrder node = new SortOrder(s.field(), dir);
            if (head == null) head = node;
            else head.addNextSort(node);
        }
        return head;
    }

    /** {@link Range} is (start, end) 0-indexed inclusive. Offset defaults to 0 when absent. */
    private static Range buildRange(Integer offset, int limit) {
        int start = offset == null ? 0 : offset;
        return new Range(start, start + limit - 1);
    }

    // -----------------------------------------------------------------------
    // Row extraction (ValueObject → Map<String,Object>)
    // -----------------------------------------------------------------------

    /**
     * Flatten a ValueObject (the generic instance type the integration tests
     * bind every entity to — see {@code QueryScenarioTests.beforeAll}) into
     * a metadata-field-keyed Map for normalization.
     *
     * <p>Falls through to a generic per-field reflection-free read so a
     * project that binds its own POJO doesn't have to write a custom adapter.
     * For non-ValueObject types the row is keyed by the field's metadata
     * name and the value is what {@link ObjectManagerDB} loaded.</p>
     */
    private static Map<String, Object> toRowMap(MetaObject mc, Object instance) {
        Map<String, Object> row = new LinkedHashMap<>();
        if (instance instanceof ValueObject vo) {
            for (MetaField<?> mf : mc.getMetaFields()) row.put(mf.getName(), vo.get(mf.getName()));
            return row;
        }
        // Fallback: ask each MetaField for its value off the object.
        for (MetaField<?> mf : mc.getMetaFields()) {
            try { row.put(mf.getName(), mf.getObject(instance)); }
            catch (Exception ignored) { row.put(mf.getName(), null); }
        }
        return row;
    }
}
