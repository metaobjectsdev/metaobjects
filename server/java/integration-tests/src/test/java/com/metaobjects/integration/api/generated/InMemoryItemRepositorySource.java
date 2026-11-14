package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.paging.ItemRepository} impl behind the GENERATED
 * {@code ItemController} in the {@code api-settings} sub-corpus. Test scaffolding, not a
 * conformance subject: it honours {@code limit} and {@code offset} exactly, so a page is whatever
 * size the generated controller asked for.
 */
final class InMemoryItemRepositorySource {

    private InMemoryItemRepositorySource() {}

    static final String FQCN = "acme.paging.InMemoryItemRepository";

    static final String SOURCE = """
        package acme.paging;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        public final class InMemoryItemRepository implements ItemRepository {

            private final List<ItemDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            public InMemoryItemRepository(List<ItemDto> seed) {
                long max = 0;
                for (ItemDto a : seed) {
                    rows.add(a);
                    if (a.id() != null && a.id() > max) max = a.id();
                }
                nextId.set(max + 1);
            }

            @Override
            public List<ItemDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<ItemDto> out = new ArrayList<>(rows);
                Comparator<ItemDto> c = sort != null && "title".equals(sort.field())
                    ? Comparator.comparing(ItemDto::title, Comparator.nullsLast(Comparator.naturalOrder()))
                    : Comparator.comparing(ItemDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                if (sort != null && "desc".equalsIgnoreCase(sort.direction())) c = c.reversed();
                out.sort(c);
                int from = Math.min(offset, out.size());
                int to = (int) Math.min((long) from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                return rows.size();
            }

            @Override
            public Optional<ItemDto> findById(Long id) {
                for (ItemDto a : rows) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            @Override
            public ItemDto create(ItemDto dto) {
                Long id = dto.id() != null ? dto.id() : Long.valueOf(nextId.getAndIncrement());
                ItemDto saved = new ItemDto(id, dto.title());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<ItemDto> update(Long id, ItemDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    ItemDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        ItemDto merged = new ItemDto(id, dto.title() != null ? dto.title() : cur.title());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            @Override
            public Optional<ItemDto> patch(Long id, ItemPatch patch) {
                Map<String, Object> assigned = patch.assignedValues();
                for (int i = 0; i < rows.size(); i++) {
                    ItemDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        ItemDto merged = new ItemDto(id,
                            assigned.containsKey("title") ? (String) assigned.get("title") : cur.title());
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
        }
        """;
}
