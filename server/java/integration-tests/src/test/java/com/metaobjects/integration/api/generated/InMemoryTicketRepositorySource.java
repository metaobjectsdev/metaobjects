package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.defaults.TicketRepository} impl behind the
 * GENERATED {@code TicketController} in the enum-default sub-corpus.
 *
 * <p>Test scaffolding, not a conformance subject: it stores what the controller hands it and
 * never applies a default itself, so a default seen in a response came from the generated create
 * handler. Only create, findById and list are exercised; update and patch are not.</p>
 */
final class InMemoryTicketRepositorySource {

    private InMemoryTicketRepositorySource() {}

    static final String FQCN = "acme.defaults.InMemoryTicketRepository";

    static final String SOURCE = """
        package acme.defaults;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.util.ArrayList;
        import java.util.List;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        public final class InMemoryTicketRepository implements TicketRepository {

            private final List<TicketDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            public InMemoryTicketRepository(List<TicketDto> seed) {
                long max = 0;
                for (TicketDto t : seed) {
                    rows.add(t);
                    if (t.id() != null && t.id() > max) max = t.id();
                }
                nextId.set(max + 1);
            }

            @Override
            public List<TicketDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                int from = Math.min(offset, rows.size());
                int to = Math.min(from + limit, rows.size());
                return new ArrayList<>(rows.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                return rows.size();
            }

            @Override
            public Optional<TicketDto> findById(Long id) {
                for (TicketDto t : rows) if (id.equals(t.id())) return Optional.of(t);
                return Optional.empty();
            }

            @Override
            public TicketDto create(TicketDto dto) {
                TicketDto saved = new TicketDto(nextId.getAndIncrement(), dto.title(), dto.priority());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<TicketDto> update(Long id, TicketDto dto) {
                return Optional.empty();
            }

            @Override
            public Optional<TicketDto> patch(Long id, TicketPatch patch) {
                return Optional.empty();
            }

            @Override
            public boolean delete(Long id) {
                return rows.removeIf(t -> id.equals(t.id()));
            }
        }
        """;
}
