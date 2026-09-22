package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.sales.InvoiceSummaryRepository} impl,
 * emitted alongside the GENERATED read-only controller/DTO/interface so it compiles
 * against them, then loaded + instantiated reflectively by
 * {@link GeneratedProjectionControllerHarness}.
 *
 * <p>The consumer seam MetaObjects intentionally leaves unimplemented — and for a
 * projection the seam is READ-ONLY, so this class implements exactly three methods.
 * If the generator ever emitted a write method on a projection's repository interface,
 * this class would stop compiling, which is the cheapest possible gate on that.</p>
 *
 * <p>Test scaffolding, not a conformance subject: its job is to faithfully apply the
 * controller-supplied {@code List<FilterPredicate>}, {@code SortClause} and
 * {@code limit/offset} to the seeded list, so the GENERATED controller's
 * qs&rarr;predicate&rarr;repository translation is exercised end-to-end. It must NOT
 * re-implement envelopes or status codes — those are the generated controller's job,
 * and they are what the corpus asserts.</p>
 *
 * <p>Kept as a string constant (not a real source file) so it lives entirely inside the
 * test module: it references the generated {@code acme.sales.*} types, which only exist
 * after codegen runs.</p>
 */
final class InMemoryInvoiceSummaryRepositorySource {

    private InMemoryInvoiceSummaryRepositorySource() {}

    /** Fully-qualified name of the emitted impl (package + simple name). */
    static final String FQCN = "acme.sales.InMemoryInvoiceSummaryRepository";

    static final String SOURCE = """
        package acme.sales;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Optional;

        /**
         * Hand-written in-memory {@link InvoiceSummaryRepository} (the read-only consumer
         * seam). Stands in for the SQL view v_invoice_summary, which derives from the
         * seeded invoices rows one-for-one. NOT a conformance subject — test scaffolding.
         */
        public final class InMemoryInvoiceSummaryRepository implements InvoiceSummaryRepository {

            private final List<InvoiceSummaryDto> rows = new ArrayList<>();

            public InMemoryInvoiceSummaryRepository(List<InvoiceSummaryDto> seed) {
                rows.addAll(seed);
            }

            @Override
            public List<InvoiceSummaryDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<InvoiceSummaryDto> out = new ArrayList<>();
                for (InvoiceSummaryDto r : rows) if (matchesAll(r, filters)) out.add(r);
                out.sort(comparatorFor(sort));
                int from = Math.min(offset, out.size());
                int to = Math.min(from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                long n = 0;
                for (InvoiceSummaryDto r : rows) if (matchesAll(r, filters)) n++;
                return n;
            }

            @Override
            public Optional<InvoiceSummaryDto> findById(Long id) {
                for (InvoiceSummaryDto r : rows) if (id.equals(r.id())) return Optional.of(r);
                return Optional.empty();
            }

            // --- predicate application ---------------------------------------------------

            private static boolean matchesAll(InvoiceSummaryDto r, List<FilterPredicate> filters) {
                if (filters == null) return true;
                for (FilterPredicate p : filters) if (!matches(r, p)) return false; // implicit AND
                return true;
            }

            @SuppressWarnings("unchecked")
            private static boolean matches(InvoiceSummaryDto r, FilterPredicate p) {
                Object col = column(r, p.field());
                switch (p.op()) {
                    case "isNull": {
                        boolean wantNull = Boolean.TRUE.equals(p.value());
                        return wantNull == (col == null);
                    }
                    case "in": {
                        List<String> items = (List<String>) p.value();
                        for (String item : items) if (col != null && compare(col, p.field(), item) == 0) return true;
                        return false;
                    }
                    case "like": {
                        if (col == null) return false;
                        return sqlLike(String.valueOf(col), (String) p.value());
                    }
                    default: {
                        if (col == null) return false;
                        int cmp = compare(col, p.field(), (String) p.value());
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

            private static Object column(InvoiceSummaryDto r, String field) {
                return switch (field) {
                    case "id"          -> r.id();
                    case "reference"   -> r.reference();
                    case "status"      -> r.status();
                    case "amountCents" -> r.amountCents();
                    default            -> throw new IllegalStateException("unknown column: " + field);
                };
            }

            /** Compare a column value against a raw string operand, coercing by field type. */
            private static int compare(Object col, String field, String raw) {
                return switch (field) {
                    case "id", "amountCents" -> Long.compare((Long) col, Long.parseLong(raw));
                    default                  -> String.valueOf(col).compareTo(raw);
                };
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

            private static Comparator<InvoiceSummaryDto> comparatorFor(SortClause sort) {
                String field = sort != null ? sort.field() : "id";   // default sort by id asc
                boolean desc = sort != null && "desc".equalsIgnoreCase(sort.direction());
                Comparator<InvoiceSummaryDto> c = switch (field) {
                    case "reference"   -> Comparator.comparing(InvoiceSummaryDto::reference, Comparator.nullsLast(Comparator.naturalOrder()));
                    case "status"      -> Comparator.comparing(InvoiceSummaryDto::status, Comparator.nullsLast(Comparator.naturalOrder()));
                    case "amountCents" -> Comparator.comparing(InvoiceSummaryDto::amountCents, Comparator.nullsLast(Comparator.naturalOrder()));
                    default            -> Comparator.comparing(InvoiceSummaryDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                };
                return desc ? c.reversed() : c;
            }
        }
        """;
}
