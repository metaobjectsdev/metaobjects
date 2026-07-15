package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.store.DocumentRepository} impl,
 * emitted alongside the GENERATED Document controller/DTO/interface so it
 * compiles against them, then loaded + instantiated reflectively by
 * {@link GeneratedJsonbControllerHarness}.
 *
 * <p>This is the ONLY hand-written piece of the jsonb generated lane — the
 * consumer seam behind the generated {@code DocumentRepository} interface. It is
 * test scaffolding, NOT a conformance subject (real DB behavior is gated by
 * persistence-conformance + {@code JsonbReferenceServer}). Its job is to apply
 * the controller-supplied predicates/sort/paging to a seeded list so the
 * GENERATED controller's request→repository contract is exercised end-to-end —
 * and, critically, to hold {@code payload} as an {@code Object} (the open JSON
 * bag), so the GENERATED {@code Object}-typed DTO field (#103) round-trips a
 * posted JSON object as a parsed value, not a string.</p>
 */
final class InMemoryDocumentRepositorySource {

    private InMemoryDocumentRepositorySource() {}

    /** Fully-qualified name of the emitted impl (package + simple name). */
    static final String FQCN = "acme.store.InMemoryDocumentRepository";

    static final String SOURCE = """
        package acme.store;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        /**
         * Hand-written in-memory {@link DocumentRepository} (the consumer seam). Applies the
         * GENERATED controller's validated predicates / sort / paging to a seeded list. NOT a
         * conformance subject — test scaffolding only. See InMemoryDocumentRepositorySource javadoc.
         */
        public final class InMemoryDocumentRepository implements DocumentRepository {

            private final List<DocumentDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            /** Seeded from the corpus seed.json (advances the id sequence past max(id)). */
            public InMemoryDocumentRepository(List<DocumentDto> seed) {
                long max = 0;
                for (DocumentDto d : seed) {
                    rows.add(d);
                    if (d.id() != null && d.id() > max) max = d.id();
                }
                nextId.set(max + 1);
            }

            @Override
            public List<DocumentDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<DocumentDto> out = new ArrayList<>();
                for (DocumentDto d : rows) if (matchesAll(d, filters)) out.add(d);
                out.sort(comparatorFor(sort));
                int from = Math.min(offset, out.size());
                int to = Math.min(from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                long n = 0;
                for (DocumentDto d : rows) if (matchesAll(d, filters)) n++;
                return n;
            }

            @Override
            public Optional<DocumentDto> findById(Long id) {
                for (DocumentDto d : rows) if (id.equals(d.id())) return Optional.of(d);
                return Optional.empty();
            }

            @Override
            public DocumentDto create(DocumentDto dto) {
                DocumentDto saved = new DocumentDto(nextId.getAndIncrement(), dto.title(), dto.payload(),
                    dto.primaryMarker(), dto.optionalMarker(), dto.markers());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<DocumentDto> update(Long id, DocumentDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    DocumentDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        DocumentDto merged = new DocumentDto(
                            id,
                            dto.title()   != null ? dto.title()   : cur.title(),
                            dto.payload() != null ? dto.payload() : cur.payload(),
                            dto.primaryMarker()  != null ? dto.primaryMarker()  : cur.primaryMarker(),
                            dto.optionalMarker() != null ? dto.optionalMarker() : cur.optionalMarker(),
                            dto.markers()        != null ? dto.markers()        : cur.markers());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            // FR-035 present-key PATCH: apply only the ASSIGNED fields (has<F>()). A present-null
            // clears a nullable value-object column; an absent key is untouched (Program D).
            @Override
            public Optional<DocumentDto> patch(Long id, DocumentPatch patch) {
                for (int i = 0; i < rows.size(); i++) {
                    DocumentDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        DocumentDto merged = new DocumentDto(
                            id,
                            patch.hasTitle()   ? patch.title()   : cur.title(),
                            patch.hasPayload() ? patch.payload() : cur.payload(),
                            patch.hasPrimaryMarker()  ? patch.primaryMarker()  : cur.primaryMarker(),
                            patch.hasOptionalMarker() ? patch.optionalMarker() : cur.optionalMarker(),
                            patch.hasMarkers()        ? patch.markers()        : cur.markers());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            @Override
            public boolean delete(Long id) {
                return rows.removeIf(d -> id.equals(d.id()));
            }

            // --- predicate application (id / title are the filterable columns) ---------------

            private static boolean matchesAll(DocumentDto d, List<FilterPredicate> filters) {
                if (filters == null) return true;
                for (FilterPredicate p : filters) if (!matches(d, p)) return false; // implicit AND
                return true;
            }

            @SuppressWarnings("unchecked")
            private static boolean matches(DocumentDto d, FilterPredicate p) {
                Object col = column(d, p.field());
                switch (p.op()) {
                    case "isNull": return Boolean.TRUE.equals(p.value()) == (col == null);
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

            private static Object column(DocumentDto d, String field) {
                return switch (field) {
                    case "id"    -> d.id();
                    case "title" -> d.title();
                    default      -> throw new IllegalStateException("unknown column: " + field);
                };
            }

            private static int compare(Object col, String field, String raw) {
                return "id".equals(field)
                    ? Long.compare((Long) col, Long.parseLong(raw))
                    : String.valueOf(col).compareTo(raw);
            }

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

            private static Comparator<DocumentDto> comparatorFor(SortClause sort) {
                String field = sort != null ? sort.field() : "id";   // default sort by id asc
                boolean desc = sort != null && "desc".equalsIgnoreCase(sort.direction());
                Comparator<DocumentDto> c = "title".equals(field)
                    ? Comparator.comparing(DocumentDto::title, Comparator.nullsLast(Comparator.naturalOrder()))
                    : Comparator.comparing(DocumentDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                return desc ? c.reversed() : c;
            }
        }
        """;
}
