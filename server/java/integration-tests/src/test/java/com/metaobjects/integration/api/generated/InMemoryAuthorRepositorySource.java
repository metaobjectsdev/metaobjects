package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.blog.AuthorRepository} impl,
 * emitted alongside the GENERATED controller/DTO/interface so it compiles
 * against them, then loaded + instantiated reflectively by
 * {@link GeneratedAuthorControllerHarness}.
 *
 * <p>This is the ONLY hand-written production-shaped piece of the generated
 * lane — it fills the consumer seam MetaObjects intentionally leaves
 * unimplemented (the generated {@code <Entity>Repository} interface). It is
 * <strong>test scaffolding, not a conformance subject</strong>: real DB
 * behavior is gated by persistence-conformance. Its sole job is to faithfully
 * apply the controller-supplied {@code List<FilterPredicate>} (all FR-009 ops),
 * {@code SortClause}, and {@code limit/offset} to the seeded list — so the
 * GENERATED controller's qs→predicate→repository contract translation is
 * exercised genuinely end-to-end. It must NOT re-implement validation /
 * envelopes / status codes (those are the generated controller's job).</p>
 *
 * <p>Kept as a string constant (not a real source file) so it lives entirely
 * inside the test module: it references the generated {@code acme.blog.*}
 * types which only exist after codegen runs, so it cannot be a compiled
 * member of this module.</p>
 */
final class InMemoryAuthorRepositorySource {

    private InMemoryAuthorRepositorySource() {}

    /** Fully-qualified name of the emitted impl (package + simple name). */
    static final String FQCN = "acme.blog.InMemoryAuthorRepository";

    /**
     * Java source for the impl. Compiled in the same javac pass as the
     * generated {@code AuthorController} / {@code AuthorDto} /
     * {@code AuthorRepository} / {@code AuthorFilterAllowlist}, so it binds
     * against the GENERATED interface + record by name.
     */
    static final String SOURCE = """
        package acme.blog;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        /**
         * Hand-written in-memory {@link AuthorRepository} (the consumer seam). Applies the
         * GENERATED controller's validated predicates / sort / paging to a seeded list. NOT a
         * conformance subject — test scaffolding only. See InMemoryAuthorRepositorySource javadoc.
         */
        public final class InMemoryAuthorRepository implements AuthorRepository {

            // ADR-0036 Wave 2: createdAt is a bare field.timestamp → instant/tz-aware, so the
            // generated AuthorDto.createdAt is a java.time.Instant (tz-aware instant contract).
            // Corpus filter operands are offset-less wall-clock (yyyy-MM-ddTHH:mm:ss); an
            // offset-less value is interpreted as UTC before Instant.parse.

            private final List<AuthorDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            /** Seeded from the corpus seed.json (5 authors). */
            public InMemoryAuthorRepository(List<AuthorDto> seed) {
                long max = 0;
                for (AuthorDto a : seed) {
                    rows.add(a);
                    if (a.id() != null && a.id() > max) max = a.id();
                }
                nextId.set(max + 1);
            }

            @Override
            public List<AuthorDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<AuthorDto> out = new ArrayList<>();
                for (AuthorDto a : rows) if (matchesAll(a, filters)) out.add(a);
                out.sort(comparatorFor(sort));
                int from = Math.min(offset, out.size());
                int to = Math.min(from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                long n = 0;
                for (AuthorDto a : rows) if (matchesAll(a, filters)) n++;
                return n;
            }

            @Override
            public Optional<AuthorDto> findById(Long id) {
                for (AuthorDto a : rows) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            @Override
            public AuthorDto create(AuthorDto dto) {
                // Issue #203 / ADR-0045: the generated controller already stamped @autoSet via
                // AuthorDto.stampForInsert(dto) before calling create — the repo just persists
                // the incoming (already-stamped) values verbatim.
                AuthorDto saved = new AuthorDto(nextId.getAndIncrement(), dto.name(), dto.bio(),
                    dto.createdAt(), dto.autoCreatedAt(), dto.autoUpdatedAt());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<AuthorDto> update(Long id, AuthorDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    AuthorDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        AuthorDto merged = new AuthorDto(
                            id,
                            dto.name() != null ? dto.name() : cur.name(),
                            dto.bio()  != null ? dto.bio()  : cur.bio(),
                            dto.createdAt() != null ? dto.createdAt() : cur.createdAt(),
                            dto.autoCreatedAt() != null ? dto.autoCreatedAt() : cur.autoCreatedAt(),
                            dto.autoUpdatedAt() != null ? dto.autoUpdatedAt() : cur.autoUpdatedAt());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            // FR-035 present-key PATCH: apply only the ASSIGNED fields (has<F>()), so an
            // explicit null CLEARS the column while an omitted field keeps its stored value.
            @Override
            public Optional<AuthorDto> patch(Long id, AuthorPatch patch) {
                for (int i = 0; i < rows.size(); i++) {
                    AuthorDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        // Issue #203 / ADR-0045: the generated controller called patch.stampAutoSetOnUpdate()
                        // before delegating, so hasAutoUpdatedAt() is true (→ now()) while autoCreatedAt is
                        // absent from the patch (→ keeps the OLD seed value) — the two diverge.
                        AuthorDto merged = new AuthorDto(
                            id,
                            patch.hasName()          ? patch.name()          : cur.name(),
                            patch.hasBio()           ? patch.bio()           : cur.bio(),
                            patch.hasCreatedAt()     ? patch.createdAt()     : cur.createdAt(),
                            patch.hasAutoCreatedAt() ? patch.autoCreatedAt() : cur.autoCreatedAt(),
                            patch.hasAutoUpdatedAt() ? patch.autoUpdatedAt() : cur.autoUpdatedAt());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            @Override
            public boolean delete(Long id) {
                return rows.removeIf(a -> id.equals(a.id()));
            }

            // --- predicate application -------------------------------------------------------

            private static boolean matchesAll(AuthorDto a, List<FilterPredicate> filters) {
                if (filters == null) return true;
                for (FilterPredicate p : filters) if (!matches(a, p)) return false; // implicit AND
                return true;
            }

            @SuppressWarnings("unchecked")
            private static boolean matches(AuthorDto a, FilterPredicate p) {
                Object col = column(a, p.field());
                switch (p.op()) {
                    case "isNull": {
                        boolean wantNull = Boolean.TRUE.equals(p.value());
                        return wantNull == (col == null);
                    }
                    case "in": {
                        List<String> items = (List<String>) p.value();
                        for (String item : items) if (eq(col, p.field(), item)) return true;
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

            private static Object column(AuthorDto a, String field) {
                return switch (field) {
                    case "id"        -> a.id();
                    case "name"      -> a.name();
                    case "bio"       -> a.bio();
                    case "createdAt" -> a.createdAt();
                    default          -> throw new IllegalStateException("unknown column: " + field);
                };
            }

            private static boolean eq(Object col, String field, String raw) {
                if (col == null) return false;
                return compare(col, field, raw) == 0;
            }

            /** Compare a column value against a raw string operand, coercing by field type. */
            private static int compare(Object col, String field, String raw) {
                return switch (field) {
                    case "id"        -> Long.compare((Long) col, Long.parseLong(raw));
                    case "createdAt" -> ((Instant) col).compareTo(parseInstant(raw));
                    default          -> String.valueOf(col).compareTo(raw); // name / bio
                };
            }

            /** Offset-less corpus operands are interpreted as UTC instants (append Z). */
            private static Instant parseInstant(String raw) {
                String s = (raw.endsWith("Z") || raw.contains("+")) ? raw : raw + "Z";
                return Instant.parse(s);
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

            private static Comparator<AuthorDto> comparatorFor(SortClause sort) {
                String field = sort != null ? sort.field() : "id";   // default sort by id asc
                boolean desc = sort != null && "desc".equalsIgnoreCase(sort.direction());
                Comparator<AuthorDto> c = switch (field) {
                    case "name"      -> Comparator.comparing(AuthorDto::name, Comparator.nullsLast(Comparator.naturalOrder()));
                    case "createdAt" -> Comparator.comparing(AuthorDto::createdAt, Comparator.nullsLast(Comparator.naturalOrder()));
                    default          -> Comparator.comparing(AuthorDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                };
                return desc ? c.reversed() : c;
            }
        }
        """;
}
