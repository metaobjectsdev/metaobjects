package com.metaobjects.integration;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.MetaRoot;
import com.metaobjects.database.CoreDBMetaDataProvider;
import com.metaobjects.field.MetaField;
import com.metaobjects.integration.Scenarios.QuerySpec;
import com.metaobjects.integration.Scenarios.SortSpec;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.M2MResolver;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.TphHelper;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.relationship.MetaRelationship;

import java.sql.Types;
import java.time.ZoneOffset;
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
     *   <li>{@code op:list}   → {@code List<Map<String,Object>>} of normalized rows</li>
     *   <li>{@code op:get}    → {@code Map<String,Object>} or {@code null}</li>
     *   <li>{@code op:count}  → {@code Long}</li>
     *   <li>{@code op:relate} → {@code List<Map<String,Object>>} of related target
     *       rows (order-independent — see {@link Normalization}); traverses an M:N
     *       relationship via {@link M2MResolver}.</li>
     * </ul>
     *
     * @param root the loaded model root (needed by op:relate to find the junction +
     *             target entities); other ops ignore it.
     */
    static Object execute(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc, QuerySpec spec,
                          Map<String, Integer> columnSqlTypes, MetaRoot root,
                          ColumnTypeProbe columnTypeProbe) throws Exception {
        if ("relate".equals(spec.op())) {
            return executeRelate(omdb, conn, mc, spec, root, columnTypeProbe);
        }
        if ("create".equals(spec.op())) {
            return executeCreate(omdb, conn, mc, spec, columnSqlTypes);
        }
        if ("update".equals(spec.op())) {
            return executeUpdate(omdb, conn, mc, spec, columnSqlTypes);
        }
        if ("delete".equals(spec.op())) {
            return executeDelete(omdb, conn, mc, spec);
        }

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
        for (Object o : raw) rows.add(toRowMap(mc, o, columnSqlTypes));

        if ("get".equals(spec.op())) return rows.isEmpty() ? null : rows.get(0);
        return rows; // op:list
    }

    /** Probes the actual SQL column types for a target entity's relation, on demand. */
    @FunctionalInterface
    interface ColumnTypeProbe {
        Map<String, Integer> probe(MetaObject mc);
    }

    /**
     * op:relate — traverse an M:N relationship from a single source object to its
     * related target rows. Loads the source by {@code by:{...}}, locates the named
     * {@code relation}, delegates the junction traversal + target load to the
     * generic {@link M2MResolver}, then normalizes the target rows. The {@code relate}
     * verb is order-independent (the runner sorts both sides before comparing).
     */
    private static Object executeRelate(ObjectManagerDB omdb, ObjectConnection conn, MetaObject sourceMeta,
                                        QuerySpec spec, MetaRoot root, ColumnTypeProbe columnTypeProbe) throws Exception {
        // 1. Load the single source object identified by `by`.
        Expression byFilter = buildFilter(spec.by(), null);
        QueryOptions opts = new QueryOptions();
        if (byFilter != null) opts.setExpression(byFilter);
        Collection<?> sources = omdb.getObjects(conn, sourceMeta, opts);
        if (sources.isEmpty()) return List.of(); // unknown source → no related rows

        Object source = sources.iterator().next();

        // 2. Find the named M:N relationship on the source entity.
        MetaRelationship rel = findRelationship(sourceMeta, spec.relation());
        if (rel == null) {
            throw new AssertionError("op:relate / " + spec.name() + ": no relationship named '"
                + spec.relation() + "' on entity '" + sourceMeta.getShortName() + "'");
        }

        // 3. Resolve the related targets via the generic OMDB M:N resolver.
        Collection<?> related = new M2MResolver(omdb).resolve(conn, source, sourceMeta, rel, root);

        // 4. Normalize the target rows (keyed by the TARGET entity's metadata).
        MetaObject targetMeta = mustGetEntity(root, rel.getObjectRef());
        Map<String, Integer> targetColumnSqlTypes = columnTypeProbe.probe(targetMeta);
        List<Map<String, Object>> rows = new ArrayList<>(related.size());
        for (Object o : related) rows.add(toRowMap(targetMeta, o, targetColumnSqlTypes));
        return rows;
    }

    /**
     * op:create — INSERT a row through the OMDB runtime WRITE path (NOT raw SQL). Author the
     * {@code data:} row into a fresh instance, coercing each value to its native type, then
     * {@code createObject} (OMDB injects the TPH discriminator from the subtype entity + mints the
     * server-generated PK), read the row back BY PK (a fresh SELECT, so the read codec runs) and
     * return the wire row WITH the PK retained (the create {@code expect} block asserts the id).
     * Mirrors the Python query-runner {@code op: create} and the TS/C# reference.
     */
    private static Object executeCreate(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc,
                                        QuerySpec spec, Map<String, Integer> columnSqlTypes) throws Exception {
        if (spec.data() == null) {
            throw new AssertionError("op:create / " + spec.name() + " requires a `data` block (the row to write)");
        }
        ValueObject vo = (ValueObject) mc.newInstance();
        RoundtripWriter.applyValues(mc, vo, spec.data());
        omdb.createObject(conn, vo); // OMDB injects the @discriminator value for a TPH subtype

        MetaField<?> pk = RoundtripWriter.primaryKey(mc);
        Object reread = loadByKey(omdb, conn, mc, Map.of(pk.getName(), vo.get(pk.getName())));
        if (reread == null) return null;
        return toRowMap(mc, reread, columnSqlTypes); // PK retained (create expect includes id)
    }

    /**
     * op:update — PATCH a row through the OMDB runtime WRITE path (NOT raw SQL). Load the row by
     * {@code by:{id}}, apply the {@code data:} patch coercing each value to its native type (the
     * SAME write coercion {@code op: roundtrip} uses on INSERT — so a port whose UPDATE codec
     * differs from its INSERT codec is caught), {@code updateObject}, then read the row back BY PK
     * (a fresh SELECT, so the read codec runs) and return the wire row WITH the PK retained (the
     * update {@code expect} block asserts the id).
     */
    private static Object executeUpdate(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc,
                                        QuerySpec spec, Map<String, Integer> columnSqlTypes) throws Exception {
        if (spec.data() == null) {
            throw new AssertionError("op:update / " + spec.name() + " requires a `data` block (the patch to write)");
        }
        MetaField<?> pk = RoundtripWriter.primaryKey(mc);
        Object pkValue = spec.by() == null ? null : spec.by().get(pk.getName());
        if (pkValue == null) {
            throw new AssertionError("op:update / " + spec.name()
                + " requires a `by` block carrying the primary key '" + pk.getName() + "'");
        }

        // FR-017 TPH: a subtype update is LOAD-then-mutate, SCOPED. Load the existing row through
        // getObjects (which AND's the discriminator for a subtype), so a row of a different subtype
        // — or an absent id — is invisible and the cross-subtype write is rejected (expect-error).
        // Mutating the loaded row keeps the other subtype columns intact (a partial TPH patch must
        // not NULL the unmodified columns), and applyValues throws if a patch key isn't a field of
        // this subtype (the cross-subtype-COLUMN rejection). The seed-row jsonb caveat below does
        // not apply to TPH — the auths table has no jsonb, so reading the row back to mutate works.
        if (TphHelper.tphSubtypeOf(mc) != null) {
            Object existing = loadByKey(omdb, conn, mc, Map.of(pk.getName(), pkValue));
            if (existing == null) {
                throw new AssertionError("op:update / " + spec.name() + ": no " + mc.getShortName()
                    + " row with " + pk.getName() + "=" + pkValue + " in subtype scope");
            }
            ValueObject scoped = (ValueObject) existing;
            RoundtripWriter.applyValues(mc, scoped, spec.data()); // throws on a non-field (cross-subtype column)
            omdb.updateObject(conn, scoped);
            Object rereadTph = loadByKey(omdb, conn, mc, Map.of(pk.getName(), scoped.get(pk.getName())));
            if (rereadTph == null) return null;
            return toRowMap(mc, rereadTph, columnSqlTypes);
        }

        // Author a fresh instance carrying the PK + the data patch, and UPDATE by PK through the
        // runtime write path (the WRITE codecs run here). The corpus update patches every column,
        // so the row is fully specified. We do NOT load-then-mutate: the seed row's jsonb was
        // raw-SQL-inserted without the @type discriminator the metadata-driven deserializer
        // expects, so reading it back to mutate would fail; building fresh sidesteps that and
        // still proves the UPDATE codec re-encodes each subtype (it is the write path under test).
        ValueObject vo = (ValueObject) mc.newInstance();
        RoundtripWriter.applyValues(mc, vo, Map.of(pk.getName(), pkValue));
        RoundtripWriter.applyValues(mc, vo, spec.data());
        omdb.updateObject(conn, vo);

        // Read the row back BY PK so the read codec runs (not an in-memory echo of the patch).
        Object reread = loadByKey(omdb, conn, mc, Map.of(pk.getName(), vo.get(pk.getName())));
        if (reread == null) return null;
        return toRowMap(mc, reread, columnSqlTypes); // PK retained (update expect includes id)
    }

    /**
     * op:delete — DELETE a row by PK through the OMDB runtime WRITE path. Load the row by
     * {@code by:{id}}; if none, return {@code false}. Otherwise {@code deleteObject} and return
     * {@code true}. The portable proof the row is gone is a follow-up {@code op: get} asserting null.
     */
    private static Object executeDelete(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc,
                                        QuerySpec spec) throws Exception {
        // Delete by PK through the runtime DELETE path. Use deleteObjects(mc, expression) — a
        // set-based delete-by-key — so we do NOT load-then-delete: the seed row's raw-SQL jsonb
        // (no @type discriminator) would fail the metadata-driven deserialize on load. The count
        // is the boolean outcome (>0 = a row was deleted).
        Expression byFilter = buildFilter(spec.by(), null);
        int deleted = omdb.deleteObjects(conn, mc, byFilter);
        return deleted > 0;
    }

    /** Load a single object by an exact-match key map, or {@code null} when no row matches. */
    private static Object loadByKey(ObjectManagerDB omdb, ObjectConnection conn, MetaObject mc,
                                    Map<String, Object> key) throws Exception {
        Expression filter = buildFilter(key, null);
        QueryOptions opts = new QueryOptions();
        if (filter != null) opts.setExpression(filter);
        Collection<?> rows = omdb.getObjects(conn, mc, opts);
        return rows.isEmpty() ? null : rows.iterator().next();
    }

    private static MetaRelationship findRelationship(MetaObject mc, String relationName) {
        if (relationName == null) return null;
        for (MetaRelationship rel : mc.getRelationships()) {
            if (relationName.equals(rel.getShortName())) return rel;
        }
        return null;
    }

    private static MetaObject mustGetEntity(MetaRoot root, String name) {
        String bare = name;
        int idx = name.lastIndexOf(com.metaobjects.MetaData.PKG_SEPARATOR);
        if (idx >= 0) bare = name.substring(idx + com.metaobjects.MetaData.PKG_SEPARATOR.length());
        for (MetaObject mc : root.getChildren(MetaObject.class, false)) {
            if (bare.equals(mc.getShortName())) return mc;
        }
        throw new IllegalStateException("Entity '" + name + "' not found in model root");
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
    /**
     * Package-visible entry to the read-path row normalizer for the {@code op: roundtrip}
     * writer ({@link RoundtripWriter}), which reads the inserted row back by PK and needs the
     * SAME field-keyed wire projection (jsonb parse + wire-type coercion) the read scenarios
     * use, so the WRITE round-trip asserts against a byte-identical wire shape.
     */
    static Map<String, Object> toRowMapForRoundtrip(MetaObject mc, Object instance,
                                                    Map<String, Integer> columnSqlTypes) {
        return toRowMap(mc, instance, columnSqlTypes);
    }

    private static Map<String, Object> toRowMap(MetaObject mc, Object instance,
                                                Map<String, Integer> columnSqlTypes) {
        Map<String, Object> row = new LinkedHashMap<>();
        if (instance instanceof ValueObject vo) {
            for (MetaField<?> mf : mc.getMetaFields())
                row.put(mf.getName(), coerceWireType(mf, maybeParseJson(mf, vo.get(mf.getName())), columnSqlTypes));
            return row;
        }
        // Fallback: ask each MetaField for its value off the object.
        for (MetaField<?> mf : mc.getMetaFields()) {
            try { row.put(mf.getName(), coerceWireType(mf, maybeParseJson(mf, mf.getObject(instance)), columnSqlTypes)); }
            catch (Exception ignored) { row.put(mf.getName(), null); }
        }
        return row;
    }

    /**
     * Reconcile OMDB's MetaField-typed value with the ACTUAL SQL column type so the
     * canonical wire shape ({@code fixtures/persistence-conformance/normalization.md})
     * is driven by the column, not the {@code field.*} declaration. OMDB collapses
     * every numeric column to its field subtype's Java type and reads both plain and
     * tz-aware timestamps as the same {@link java.sql.Timestamp}; two corpus cases
     * need the lost distinction restored:
     *
     * <ul>
     *   <li><b>Aggregate INTEGER projections.</b> {@code MIN(int)}/{@code MAX(int)}
     *       are declared {@code field.long} on the view but are INTEGER columns —
     *       INTEGER → JSON <em>number</em>, BIGINT → JSON <em>string</em>. OMDB reads
     *       both as {@link Long}; narrow to {@link Integer} when the catalog reports
     *       an INTEGER/SMALLINT column so {@link Normalization} emits a number.</li>
     *   <li><b>TIMESTAMPTZ.</b> A {@code field.timestamp} flagged
     *       {@code @dbColumnType: timestamp_with_tz} is an absolute instant whose wire
     *       form carries a {@code Z}; surface it as an {@link java.time.OffsetDateTime}
     *       in UTC so {@link Normalization} appends the suffix (a plain TIMESTAMP stays
     *       a {@link java.sql.Timestamp} and renders with no {@code Z}).</li>
     * </ul>
     *
     * <p>NUMERIC/DECIMAL needs no fix-up here: as of SP-D Unit 2 {@code DecimalField}
     * is backed by {@code DataTypes.DECIMAL}, so OMDB surfaces an exact
     * {@link java.math.BigDecimal} natively and {@link Normalization} canonicalizes
     * it directly (the prior {@code BigDecimal.valueOf(double)} workaround is gone).</p>
     */
    private static Object coerceWireType(MetaField<?> mf, Object value, Map<String, Integer> columnSqlTypes) {
        if (value == null) return null;
        if (isTimestampTzField(mf) && value instanceof java.util.Date d) {
            return d.toInstant().atOffset(ZoneOffset.UTC);
        }
        if (value instanceof Long l) {
            Integer sqlType = columnSqlTypes.get(mf.getName());
            if (sqlType != null && (sqlType == Types.INTEGER || sqlType == Types.SMALLINT || sqlType == Types.TINYINT)) {
                return l.intValue();
            }
        }
        return value;
    }

    /** True for a {@code field.timestamp} carrying {@code @dbColumnType: timestamp_with_tz}. */
    private static boolean isTimestampTzField(MetaField<?> mf) {
        return hasDbColumnType(mf, CoreDBMetaDataProvider.DB_COLUMN_TYPE_TIMESTAMP_TZ);
    }

    /** True when {@code mf} carries {@code @dbColumnType: <expected>} (false on any read error). */
    private static boolean hasDbColumnType(MetaField<?> mf, String expected) {
        try {
            return mf.hasMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE)
                && expected.equals(mf.getMetaAttr(CoreDBMetaDataProvider.DB_COLUMN_TYPE).getValueAsString());
        } catch (Exception e) {
            return false;
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * R6 Plan 2b: an open-JSON column ({@code @dbColumnType: jsonb}) is a
     * {@code field.string} whose stored value is raw JSON text. The cross-port
     * corpus asserts the <em>parsed</em> structure (and the row normalizer then
     * re-serializes it with sorted keys), so parse the JSON string here before
     * normalization. Non-jsonb fields and non-string values pass through unchanged.
     */
    private static Object maybeParseJson(MetaField<?> mf, Object value) {
        if (!hasDbColumnType(mf, CoreDBMetaDataProvider.DB_COLUMN_TYPE_JSONB) || !(value instanceof String s)) {
            return value;
        }
        try {
            return JSON.readValue(s, Object.class);
        } catch (Exception e) {
            return value; // not JSON — leave as-is
        }
    }
}
