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

        import java.math.BigDecimal;
        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
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
            public List<AuthDto> list(int limit, int offset, SortClause sort) {
                return page(sorted(new ArrayList<>(rows), sort), limit, offset);
            }

            @Override
            public long count() {
                return rows.size();
            }

            @Override
            public Optional<AuthDto> findById(Long id) {
                for (AuthDto a : rows) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            // --- per-subtype (scoped to the discriminator value) ---

            @Override
            public List<AuthDto> listByType(String discriminator, int limit, int offset, SortClause sort) {
                List<AuthDto> scoped = new ArrayList<>();
                for (AuthDto a : rows) if (discriminator.equals(a.type())) scoped.add(a);
                return page(sorted(scoped, sort), limit, offset);
            }

            @Override
            public Optional<AuthDto> findByIdAndType(Long id, String discriminator) {
                for (AuthDto a : rows)
                    if (id.equals(a.id()) && discriminator.equals(a.type())) return Optional.of(a);
                return Optional.empty();
            }

            @Override
            public AuthDto createWithType(String discriminator, AuthDto dto) {
                // Discriminator injected from the URL — dto.type() is intentionally ignored.
                AuthDto saved = new AuthDto(
                    nextId.getAndIncrement(), discriminator, dto.reference(),
                    dto.quantity(), dto.copayAmount(), dto.approver());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    AuthDto cur = rows.get(i);
                    if (!id.equals(cur.id()) || !discriminator.equals(cur.type())) continue;
                    // Partial patch; discriminator (type) and id are immutable.
                    AuthDto merged = new AuthDto(
                        id, cur.type(),
                        dto.reference()   != null ? dto.reference()   : cur.reference(),
                        dto.quantity()    != null ? dto.quantity()    : cur.quantity(),
                        dto.copayAmount() != null ? dto.copayAmount() : cur.copayAmount(),
                        dto.approver()    != null ? dto.approver()    : cur.approver());
                    rows.set(i, merged);
                    return Optional.of(merged);
                }
                return Optional.empty(); // absent or cross-subtype → controller 404s
            }

            @Override
            public boolean deleteByIdAndType(Long id, String discriminator) {
                return rows.removeIf(a -> id.equals(a.id()) && discriminator.equals(a.type()));
            }

            // --- helpers ---

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
