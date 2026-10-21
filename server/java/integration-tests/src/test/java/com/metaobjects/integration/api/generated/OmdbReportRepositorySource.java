package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for an OMDB-backed {@code acme.sales.<Report>Repository} impl: ONE generic
 * template, instantiated once per served report by substituting the report's name. Emitted
 * alongside the GENERATED controller / DTO / interface so it compiles against them, then
 * loaded and instantiated reflectively by {@link GeneratedReportControllerHarness}.
 *
 * <p>This is the adopter-owned seam of a served report ({@code list} and {@code count}
 * only), written the way an adopter writes it: it translates the controller's
 * {@code FilterPredicate} list, {@code SortClause} and {@code limit/offset} into an OMDB
 * {@code Expression}, {@code SortOrder} and {@code Range}, and reads the report's view
 * through {@code ObjectManagerDB.getObjects} / {@code getObjectsCount}, which route a report
 * through its read model. No SQL is written here: the view is the TypeScript-produced one the
 * test database executed (ADR-0015), and the SQL the filters become is the driver's.</p>
 *
 * <p>Generic over the row: an operand is coerced by the read-model field's declared subtype,
 * and a row becomes the generated record through Jackson, so nothing here names a report's
 * fields.</p>
 */
final class OmdbReportRepositorySource {

    private OmdbReportRepositorySource() {}

    private static final String PKG = "acme.sales";
    private static final String NAME = "__REPORT__";

    /** Simple name of the emitted impl for {@code report}. */
    static String simpleName(String report) {
        return "Omdb" + report + "Repository";
    }

    /** Fully-qualified name of the emitted impl for {@code report}. */
    static String fqcn(String report) {
        return fqcn(PKG, report);
    }

    /** Fully-qualified name of the emitted impl for {@code report} in package {@code pkg}. */
    static String fqcn(String pkg, String report) {
        return pkg + "." + simpleName(report);
    }

    /** The impl source for {@code report}. */
    static String source(String report) {
        return source(PKG, report);
    }

    /** The impl source for {@code report}, in the package {@code pkg} its generated types are in. */
    static String source(String pkg, String report) {
        return TEMPLATE.replace("__PKG__", pkg).replace(NAME, report);
    }

    private static final String TEMPLATE = """
        package __PKG__;

        import com.fasterxml.jackson.databind.ObjectMapper;
        import com.fasterxml.jackson.databind.SerializationFeature;
        import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
        import com.metaobjects.field.MetaField;
        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.manager.ObjectConnection;
        import com.metaobjects.manager.QueryOptions;
        import com.metaobjects.manager.db.ObjectManagerDB;
        import com.metaobjects.manager.exp.Expression;
        import com.metaobjects.manager.exp.Range;
        import com.metaobjects.manager.exp.SortOrder;
        import com.metaobjects.object.MetaObject;
        import com.metaobjects.object.value.ValueObject;

        import java.math.BigDecimal;
        import java.time.LocalDate;
        import java.time.ZoneOffset;
        import java.util.ArrayList;
        import java.util.LinkedHashMap;
        import java.util.List;
        import java.util.Map;

        /**
         * Hand-written OMDB-backed {@link __REPORT__Repository} (the read-only consumer seam):
         * reads the report's view through ObjectManagerDB. NOT a conformance subject: it is the
         * adopter's code, and the GENERATED controller above it is what the corpus gates.
         */
        public final class Omdb__REPORT__Repository implements __REPORT__Repository {

            private static final ObjectMapper MAPPER = new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

            private final ObjectManagerDB omdb;
            private final MetaObject report;
            private final MetaObject row;

            public Omdb__REPORT__Repository(ObjectManagerDB omdb, MetaObject report) {
                this.omdb = omdb;
                this.report = report;
                this.row = omdb.readObjectFor(report);
            }

            @Override
            public List<__REPORT__Dto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                ObjectConnection c = omdb.getConnection();
                try {
                    QueryOptions options = new QueryOptions();
                    Expression where = where(filters);
                    if (where != null) options.setExpression(where);
                    if (sort != null) {
                        row.getMetaField(sort.field()); // an unknown sort column is a harness bug
                        options.setSortOrder(new SortOrder(sort.field(),
                            "desc".equalsIgnoreCase(sort.direction()) ? SortOrder.DESC : SortOrder.ASC));
                    }
                    // Range is 1-based and inclusive.
                    options.setRange(new Range(offset + 1, offset + limit));
                    List<__REPORT__Dto> out = new ArrayList<>();
                    for (Object o : omdb.getObjects(c, report, options)) out.add(toDto((ValueObject) o));
                    return out;
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                ObjectConnection c = omdb.getConnection();
                try {
                    return omdb.getObjectsCount(c, report, where(filters));
                } finally {
                    omdb.releaseConnection(c);
                }
            }

            // --- predicates -> Expression ------------------------------------------------

            @SuppressWarnings("unchecked")
            private Expression where(List<FilterPredicate> filters) {
                Expression acc = null;
                if (filters == null) return null;
                for (FilterPredicate p : filters) { // implicit AND
                    Expression e = switch (p.op()) {
                        case "isNull" -> new Expression(p.field(), null,
                            Boolean.TRUE.equals(p.value()) ? Expression.EQUAL : Expression.NOT_EQUAL);
                        case "in" -> {
                            List<Object> items = new ArrayList<>();
                            for (Object item : (List<Object>) p.value()) items.add(operand(p.field(), item));
                            yield new Expression(p.field(), items, Expression.EQUAL);
                        }
                        case "like" -> new Expression(p.field(), p.value(), Expression.LIKE);
                        case "eq"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL);
                        case "ne"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.NOT_EQUAL);
                        case "gt"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.GREATER);
                        case "gte" -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL_GREATER);
                        case "lt"  -> new Expression(p.field(), operand(p.field(), p.value()), Expression.LESSER);
                        case "lte" -> new Expression(p.field(), operand(p.field(), p.value()), Expression.EQUAL_LESSER);
                        default -> throw new IllegalStateException("unknown op: " + p.op());
                    };
                    acc = acc == null ? e : acc.and(e);
                }
                return acc;
            }

            /** A raw query operand as the read-model field's own type, so the bind is typed. */
            private Object operand(String field, Object value) {
                // ADR-0019 Amendment 1: FilterParser hands a decimal field's operand over as a BigDecimal.
                if (value instanceof BigDecimal exact) return exact;
                String raw = (String) value;
                MetaField<?> f = row.getMetaField(field);
                return switch (f.getSubType()) {
                    case "long", "currency" -> Long.valueOf(raw);
                    case "int" -> Integer.valueOf(raw);
                    case "double" -> Double.valueOf(raw);
                    case "float" -> Float.valueOf(raw);
                    case "decimal" -> new BigDecimal(raw);
                    case "boolean" -> Boolean.valueOf(raw);
                    case "date" -> LocalDate.parse(raw);
                    case "uuid" -> raw.toLowerCase(java.util.Locale.ROOT);
                    default -> raw; // string, enum symbol
                };
            }

            // --- row -> generated record -------------------------------------------------

            private __REPORT__Dto toDto(ValueObject vo) {
                Map<String, Object> values = new LinkedHashMap<>();
                for (MetaField<?> f : row.getMetaFields()) {
                    Object v = vo.get(f.getName());
                    if (v instanceof java.util.Date d) {
                        v = d.toInstant().atZone(ZoneOffset.UTC).toLocalDate().toString();
                    }
                    values.put(f.getName(), v);
                }
                return MAPPER.convertValue(values, __REPORT__Dto.class);
            }
        }
        """;
}
