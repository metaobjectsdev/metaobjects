package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for an in-memory {@code acme.sales.<Report>Repository} impl: ONE generic
 * template, instantiated once per served report by substituting the report's name. Emitted
 * alongside the GENERATED controller / DTO / interface so it compiles against them, then
 * loaded and instantiated reflectively by {@link GeneratedReportControllerHarness}.
 *
 * <p>The consumer seam MetaObjects leaves unimplemented, and for a report it is
 * {@code list} and {@code count} only. If the generator ever emitted {@code findById} or a
 * write method on a report's repository interface, this class would stop compiling.</p>
 *
 * <p>It stands in for the report's SQL view: the seeded rows are what that view returns.
 * Test scaffolding, not a conformance subject. Its job is to apply the controller-supplied
 * {@code List<FilterPredicate>}, {@code SortClause} and {@code limit/offset} faithfully, so
 * the GENERATED controller's qs to predicate to repository translation is exercised end to
 * end. Envelopes and status codes are the generated controller's job.</p>
 *
 * <p>Generic over the row: a column is read through the DTO record's own component
 * accessor and an operand is coerced by that component's declared type, so nothing here
 * names a report's fields. A decimal compares as {@link java.math.BigDecimal} (exact, and
 * scale-blind: {@code 0.4} equals {@code 0.40}), never through a double.</p>
 */
final class InMemoryReportRepositorySource {

    private InMemoryReportRepositorySource() {}

    private static final String PKG = "acme.sales";
    private static final String NAME = "__REPORT__";

    /** Simple name of the emitted impl for {@code report}. */
    static String simpleName(String report) {
        return "InMemory" + report + "Repository";
    }

    /** Fully-qualified name of the emitted impl for {@code report}. */
    static String fqcn(String report) {
        return PKG + "." + simpleName(report);
    }

    /** The impl source for {@code report}. */
    static String source(String report) {
        return TEMPLATE.replace(NAME, report);
    }

    private static final String TEMPLATE = """
        package acme.sales;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.lang.reflect.RecordComponent;
        import java.math.BigDecimal;
        import java.time.LocalDate;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;

        /**
         * Hand-written in-memory {@link __REPORT__Repository} (the read-only consumer seam).
         * Stands in for the report's SQL view. NOT a conformance subject: test scaffolding.
         */
        public final class InMemory__REPORT__Repository implements __REPORT__Repository {

            private final List<__REPORT__Dto> rows = new ArrayList<>();

            public InMemory__REPORT__Repository(List<__REPORT__Dto> seed) {
                rows.addAll(seed);
            }

            @Override
            public List<__REPORT__Dto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<__REPORT__Dto> out = new ArrayList<>();
                for (__REPORT__Dto r : rows) if (matchesAll(r, filters)) out.add(r);
                // No sort: the view's own order, which is the seed's.
                if (sort != null) out.sort(comparatorFor(sort));
                int from = Math.min(offset, out.size());
                int to = Math.min(from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                long n = 0;
                for (__REPORT__Dto r : rows) if (matchesAll(r, filters)) n++;
                return n;
            }

            // --- the row, read generically ------------------------------------------------

            private static RecordComponent component(String field) {
                for (RecordComponent c : __REPORT__Dto.class.getRecordComponents()) {
                    if (c.getName().equals(field)) return c;
                }
                throw new IllegalStateException("unknown column: " + field);
            }

            private static Object column(__REPORT__Dto r, String field) {
                try {
                    return component(field).getAccessor().invoke(r);
                } catch (ReflectiveOperationException e) {
                    throw new IllegalStateException("cannot read column " + field, e);
                }
            }

            /** A raw query operand as the column's own type, so the comparison is typed. */
            private static Comparable<Object> operand(String field, String raw) {
                Class<?> type = component(field).getType();
                Object value;
                if (type == Long.class) value = Long.valueOf(raw);
                else if (type == Integer.class) value = Integer.valueOf(raw);
                else if (type == Double.class) value = Double.valueOf(raw);
                else if (type == Float.class) value = Float.valueOf(raw);
                else if (type == BigDecimal.class) value = new BigDecimal(raw);
                else if (type == LocalDate.class) value = LocalDate.parse(raw);
                else if (type == Boolean.class) value = Boolean.valueOf(raw);
                else if (type == String.class) value = raw;
                else throw new IllegalStateException("no operand coercion for " + type.getName() + " (" + field + ")");
                return comparable(value);
            }

            @SuppressWarnings("unchecked")
            private static Comparable<Object> comparable(Object value) {
                return (Comparable<Object>) value;
            }

            // --- predicate application ---------------------------------------------------

            private static boolean matchesAll(__REPORT__Dto r, List<FilterPredicate> filters) {
                if (filters == null) return true;
                for (FilterPredicate p : filters) if (!matches(r, p)) return false; // implicit AND
                return true;
            }

            @SuppressWarnings("unchecked")
            private static boolean matches(__REPORT__Dto r, FilterPredicate p) {
                Object col = column(r, p.field());
                switch (p.op()) {
                    case "isNull": {
                        boolean wantNull = Boolean.TRUE.equals(p.value());
                        return wantNull == (col == null);
                    }
                    case "in": {
                        if (col == null) return false;
                        for (String item : (List<String>) p.value()) {
                            if (comparable(col).compareTo(operand(p.field(), item)) == 0) return true;
                        }
                        return false;
                    }
                    case "like": {
                        if (col == null) return false;
                        return sqlLike(String.valueOf(col), (String) p.value());
                    }
                    default: {
                        if (col == null) return false;
                        // compareTo, never equals: BigDecimal.equals is scale-sensitive.
                        int cmp = comparable(col).compareTo(operand(p.field(), (String) p.value()));
                        return switch (p.op()) {
                            case "eq"  -> cmp == 0;
                            case "ne"  -> cmp != 0;
                            case "gt"  -> cmp > 0;
                            case "gte" -> cmp >= 0;
                            case "lt"  -> cmp < 0;
                            case "lte" -> cmp <= 0;
                            default    -> throw new IllegalStateException("unknown op: " + p.op());
                        };
                    }
                }
            }

            /** SQL LIKE with `%` (any run) and `_` (any single char), anchored full-string match. */
            private static boolean sqlLike(String value, String pattern) {
                StringBuilder re = new StringBuilder("^");
                for (int i = 0; i < pattern.length(); i++) {
                    char c = pattern.charAt(i);
                    if (c == '%') re.append(".*");
                    else if (c == '_') re.append('.');
                    else re.append(java.util.regex.Pattern.quote(String.valueOf(c)));
                }
                re.append("$");
                return value.matches(re.toString());
            }

            private static Comparator<__REPORT__Dto> comparatorFor(SortClause sort) {
                String field = sort.field();
                component(field); // an unknown sort column is a harness bug, not an empty sort
                Comparator<__REPORT__Dto> c = Comparator.comparing(
                    r -> comparable(column(r, field)), Comparator.nullsLast(Comparator.naturalOrder()));
                return "desc".equalsIgnoreCase(sort.direction()) ? c.reversed() : c;
            }
        }
        """;
}
