package com.metaobjects.integration.api.tph.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.auth.AuthRepository} impl, emitted alongside the
 * GENERATED TPH controller/DTO/interface so it compiles against them, then loaded + instantiated
 * reflectively by {@link GeneratedTphControllerHarness}.
 *
 * <p>This is the ONLY hand-written piece of the generated TPH lane — it fills the consumer seam
 * behind the generated {@code AuthRepository} interface (the single-table hierarchy store). It is
 * <strong>test scaffolding, not a conformance subject</strong>: real single-table persistence is
 * gated by {@code persistence-conformance}'s {@code tph-*} query scenarios. Its sole job is to
 * faithfully apply the GENERATED controller's discriminator-scoped calls to a seeded in-memory
 * list — so the generated controller's URL-grammar → discriminator-injection → repository contract
 * is exercised end-to-end. It must NOT re-implement envelopes / status codes (the controller's job).</p>
 *
 * <p>The base {@code AuthDto} is the UNION of all subtype columns (the TPH-base DTO shape), so a
 * single record type backs both polymorphic and per-subtype rows. Discriminator scoping is a plain
 * {@code type.equals(discriminator)} filter; a create injects the URL-supplied discriminator and
 * never reads {@code dto.type()}.</p>
 */
final class InMemoryAuthRepositorySource {

    private InMemoryAuthRepositorySource() {}

    /** Fully-qualified name of the emitted impl (package + simple name). */
    static final String FQCN = "acme.auth.InMemoryAuthRepository";

    /**
     * Java source for the impl. Compiled in the same javac pass as the generated
     * {@code AuthController} / {@code AuthDto} / {@code AuthRepository}, so it binds against the
     * GENERATED interface + record (the union {@code AuthDto}) by name.
     */
    static final String SOURCE = """
        package acme.auth;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.math.BigDecimal;
        import java.time.Instant;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        /**
         * Hand-written in-memory {@link AuthRepository} (the consumer seam) over the single TPH
         * {@code auths} table. NOT a conformance subject — test scaffolding only. See
         * InMemoryAuthRepositorySource javadoc.
         */
        public final class InMemoryAuthRepository implements AuthRepository {

            private final List<AuthDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            /** Seeded from the corpus tph/seed.json (one row per subtype). */
            public InMemoryAuthRepository(List<AuthDto> seed) {
                long max = 0;
                for (AuthDto a : seed) {
                    rows.add(a);
                    if (a.id() != null && a.id() > max) max = a.id();
                }
                nextId.set(max + 1);
            }

            // --- polymorphic (whole table) ---

            @Override
            public List<AuthDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                return page(sorted(filtered(rows, filters), sort), limit, offset);
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                return filtered(rows, filters).size();
            }

            @Override
            public Optional<AuthDto> findById(Long id) {
                for (AuthDto a : rows) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            // --- per-subtype (scoped to the discriminator value) ---

            @Override
            public List<AuthDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<AuthDto> scoped = new ArrayList<>();
                for (AuthDto a : rows) if (discriminator.equals(a.type().name())) scoped.add(a);
                return page(sorted(filtered(scoped, filters), sort), limit, offset);
            }

            @Override
            public Optional<AuthDto> findByIdAndType(Long id, String discriminator) {
                for (AuthDto a : rows)
                    if (id.equals(a.id()) && discriminator.equals(a.type().name())) return Optional.of(a);
                return Optional.empty();
            }

            @Override
            public AuthDto createWithType(String discriminator, AuthDto dto) {
                // Discriminator injected from the URL — dto.type() is intentionally ignored.
                // `type` is a value-constrained enum (field.enum discriminator), so coerce the
                // String URL discriminator into the generated AuthType (its members ARE the
                // discriminator values).
                //
                // ADR-0045 (#203/#229): the GENERATED controller already stamped @autoSet via
                // AuthDto.stampForInsert(dto) before calling createWithType — the repo just
                // persists the incoming (already-stamped) autoCreatedAt/autoUpdatedAt verbatim.
                AuthDto saved = new AuthDto(
                    nextId.getAndIncrement(), AuthDto.AuthType.valueOf(discriminator), dto.reference(),
                    // FR-037 R1: writeOnce IS bound on create — settable exactly once.
                    dto.issuedCurrency(),
                    dto.autoCreatedAt(), dto.autoUpdatedAt(),
                    dto.quantity(), dto.copayAmount(), dto.approver());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    AuthDto cur = rows.get(i);
                    if (!id.equals(cur.id()) || !discriminator.equals(cur.type().name())) continue;
                    // Partial patch; discriminator (type) and id are immutable.
                    AuthDto merged = new AuthDto(
                        id, cur.type(),
                        dto.reference()     != null ? dto.reference()     : cur.reference(),
                        dto.issuedCurrency() != null ? dto.issuedCurrency() : cur.issuedCurrency(),
                        dto.autoCreatedAt() != null ? dto.autoCreatedAt() : cur.autoCreatedAt(),
                        dto.autoUpdatedAt() != null ? dto.autoUpdatedAt() : cur.autoUpdatedAt(),
                        dto.quantity()      != null ? dto.quantity()      : cur.quantity(),
                        dto.copayAmount()   != null ? dto.copayAmount()   : cur.copayAmount(),
                        dto.approver()      != null ? dto.approver()      : cur.approver());
                    rows.set(i, merged);
                    return Optional.of(merged);
                }
                return Optional.empty(); // absent or cross-subtype → controller 404s
            }

            // FR-036 Program B present-key PATCH: apply ONLY the columns PRESENT in `assigned` (an
            // explicit null → cleared; an absent column keeps its stored value). `assigned` is the
            // controller's <Sub>Patch.assignedValues() map; id + discriminator (type) are immutable.
            //
            // ADR-0045 (#203/#229): the GENERATED controller already called
            // patch.stampAutoSetOnUpdate() before delegating, so `assigned` carries "autoUpdatedAt"
            // (the bumped now()) on every PATCH; "autoCreatedAt" is never present (onCreate columns
            // are immutable on update), so it always falls through to the stored value below.
            @Override
            public Optional<AuthDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) {
                for (int i = 0; i < rows.size(); i++) {
                    AuthDto cur = rows.get(i);
                    if (!id.equals(cur.id()) || !discriminator.equals(cur.type().name())) continue;
                    AuthDto merged = new AuthDto(
                        id, cur.type(),
                        assigned.containsKey("reference")     ? (String) assigned.get("reference")       : cur.reference(),
                        // FR-037 R1: issuedCurrency is @mutability "writeOnce", so the generated
                        // <Sub>Patch has NO accessor for it and it can never appear in `assigned`
                        // — the stored value is the only thing readable here. Written as a plain
                        // read rather than a containsKey branch so the absence is visible.
                        cur.issuedCurrency(),
                        assigned.containsKey("autoCreatedAt") ? (Instant) assigned.get("autoCreatedAt")  : cur.autoCreatedAt(),
                        assigned.containsKey("autoUpdatedAt") ? (Instant) assigned.get("autoUpdatedAt")  : cur.autoUpdatedAt(),
                        assigned.containsKey("quantity")      ? (Integer) assigned.get("quantity")       : cur.quantity(),
                        assigned.containsKey("copayAmount")   ? (BigDecimal) assigned.get("copayAmount") : cur.copayAmount(),
                        assigned.containsKey("approver")      ? (String) assigned.get("approver")        : cur.approver());
                    rows.set(i, merged);
                    return Optional.of(merged);
                }
                return Optional.empty(); // absent or cross-subtype → controller 404s
            }

            @Override
            public boolean deleteByIdAndType(Long id, String discriminator) {
                return rows.removeIf(a -> id.equals(a.id()) && discriminator.equals(a.type().name()));
            }

            // --- helpers ---

            /** Apply the GENERATED controller's validated FR-009 predicates (implicit AND) over the union row. */
            private static List<AuthDto> filtered(List<AuthDto> in, List<FilterPredicate> filters) {
                if (filters == null || filters.isEmpty()) return new ArrayList<>(in);
                List<AuthDto> out = new ArrayList<>();
                for (AuthDto a : in) if (matchesAll(a, filters)) out.add(a);
                return out;
            }

            private static boolean matchesAll(AuthDto a, List<FilterPredicate> filters) {
                for (FilterPredicate p : filters) if (!matches(a, p)) return false;
                return true;
            }

            @SuppressWarnings("unchecked")
            private static boolean matches(AuthDto a, FilterPredicate p) {
                Object col = column(a, p.field());
                switch (p.op()) {
                    case "isNull": return Boolean.TRUE.equals(p.value()) == (col == null);
                    case "in": {
                        for (Object item : (List<Object>) p.value()) if (col != null && cmp(col, item) == 0) return true;
                        return false;
                    }
                    case "like": return col != null && sqlLike(String.valueOf(col), String.valueOf(p.value()));
                    default: {
                        if (col == null) return false;
                        int c = cmp(col, p.value());
                        return switch (p.op()) {
                            case "eq" -> c == 0; case "ne" -> c != 0;
                            case "gt" -> c > 0; case "gte" -> c >= 0;
                            case "lt" -> c < 0; case "lte" -> c <= 0;
                            default -> throw new IllegalStateException("unknown op: " + p.op());
                        };
                    }
                }
            }

            private static Object column(AuthDto a, String field) {
                return switch (field) {
                    case "id" -> a.id();
                    case "type" -> a.type();
                    case "reference" -> a.reference();
                    case "quantity" -> a.quantity();
                    case "copayAmount" -> a.copayAmount();
                    case "approver" -> a.approver();
                    default -> throw new IllegalStateException("unknown column: " + field);
                };
            }

            /** Compare a column value against a raw FilterParser operand (a String), coercing by the column's type. */
            private static int cmp(Object col, Object operandRaw) {
                String operand = String.valueOf(operandRaw);
                if (col instanceof Long l) return Long.compare(l, Long.parseLong(operand));
                if (col instanceof Integer i) return Integer.compare(i, Integer.parseInt(operand));
                if (col instanceof BigDecimal d) return d.compareTo(new BigDecimal(operand));
                return String.valueOf(col).compareTo(operand);
            }

            /** SQL LIKE with `%` (any run) and `_` (any single char), anchored full-string match. */
            private static boolean sqlLike(String value, String pattern) {
                StringBuilder re = new StringBuilder("^");
                for (int i = 0; i < pattern.length(); i++) {
                    char ch = pattern.charAt(i);
                    if (ch == '%') re.append(".*");
                    else if (ch == '_') re.append('.');
                    else re.append(java.util.regex.Pattern.quote(String.valueOf(ch)));
                }
                return value.matches(re.append("$").toString());
            }

            private static List<AuthDto> sorted(List<AuthDto> in, SortClause sort) {
                String field = sort != null ? sort.field() : "id"; // default id asc
                boolean desc = sort != null && "desc".equalsIgnoreCase(sort.direction());
                Comparator<AuthDto> c = switch (field) {
                    case "type"      -> Comparator.comparing(AuthDto::type, Comparator.nullsLast(Comparator.naturalOrder()));
                    case "reference" -> Comparator.comparing(AuthDto::reference, Comparator.nullsLast(Comparator.naturalOrder()));
                    default          -> Comparator.comparing(AuthDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                };
                in.sort(desc ? c.reversed() : c);
                return in;
            }

            private static List<AuthDto> page(List<AuthDto> in, int limit, int offset) {
                int from = Math.min(Math.max(offset, 0), in.size());
                int to = Math.min(from + Math.max(limit, 0), in.size());
                return new ArrayList<>(in.subList(from, to));
            }
        }
        """;
}
