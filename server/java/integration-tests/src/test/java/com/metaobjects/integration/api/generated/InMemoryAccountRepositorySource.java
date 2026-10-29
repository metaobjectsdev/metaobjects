package com.metaobjects.integration.api.generated;

/**
 * The Java SOURCE for the in-memory {@code acme.secrets.AccountRepository} impl behind the
 * GENERATED {@code AccountController} in the secret-fields sub-corpus (#484).
 *
 * <p>Test scaffolding, not a conformance subject. It is written against
 * {@code patch.assignedValues()} (a generic map) rather than the {@code has<F>()} accessors on
 * purpose: whether a denied field appears on the generated {@code AccountPatch} at all is
 * exactly what the corpus is probing, and this seam must compile either way so the failure
 * lands as a scenario assertion and not as a javac error.</p>
 */
final class InMemoryAccountRepositorySource {

    private InMemoryAccountRepositorySource() {}

    static final String FQCN = "acme.secrets.InMemoryAccountRepository";

    static final String SOURCE = """
        package acme.secrets;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;

        import java.util.ArrayList;
        import java.util.Comparator;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;
        import java.util.concurrent.atomic.AtomicLong;

        public final class InMemoryAccountRepository implements AccountRepository {

            private final List<AccountDto> rows = new ArrayList<>();
            private final AtomicLong nextId = new AtomicLong(1);

            public InMemoryAccountRepository(List<AccountDto> seed) {
                long max = 0;
                for (AccountDto a : seed) {
                    rows.add(a);
                    if (a.id() != null && a.id() > max) max = a.id();
                }
                nextId.set(max + 1);
            }

            @Override
            public List<AccountDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters) {
                List<AccountDto> out = new ArrayList<>(rows);
                Comparator<AccountDto> c = sort != null && "name".equals(sort.field())
                    ? Comparator.comparing(AccountDto::name, Comparator.nullsLast(Comparator.naturalOrder()))
                    : Comparator.comparing(AccountDto::id, Comparator.nullsLast(Comparator.naturalOrder()));
                if (sort != null && "desc".equalsIgnoreCase(sort.direction())) c = c.reversed();
                out.sort(c);
                int from = Math.min(offset, out.size());
                int to = Math.min(from + limit, out.size());
                return new ArrayList<>(out.subList(from, to));
            }

            @Override
            public long count(List<FilterPredicate> filters) {
                return rows.size();
            }

            @Override
            public Optional<AccountDto> findById(Long id) {
                for (AccountDto a : rows) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            @Override
            public AccountDto create(AccountDto dto) {
                AccountDto saved = new AccountDto(nextId.getAndIncrement(), dto.name(), dto.tokenHash(), dto.pinHash());
                rows.add(saved);
                return saved;
            }

            @Override
            public Optional<AccountDto> update(Long id, AccountDto dto) {
                for (int i = 0; i < rows.size(); i++) {
                    AccountDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        AccountDto merged = new AccountDto(id,
                            dto.name() != null ? dto.name() : cur.name(),
                            dto.tokenHash() != null ? dto.tokenHash() : cur.tokenHash(),
                            dto.pinHash() != null ? dto.pinHash() : cur.pinHash());
                        rows.set(i, merged);
                        return Optional.of(merged);
                    }
                }
                return Optional.empty();
            }

            @Override
            public Optional<AccountDto> patch(Long id, AccountPatch patch) {
                Map<String, Object> assigned = patch.assignedValues();
                for (int i = 0; i < rows.size(); i++) {
                    AccountDto cur = rows.get(i);
                    if (id.equals(cur.id())) {
                        AccountDto merged = new AccountDto(id,
                            assigned.containsKey("name") ? (String) assigned.get("name") : cur.name(),
                            assigned.containsKey("tokenHash") ? (String) assigned.get("tokenHash") : cur.tokenHash(),
                            assigned.containsKey("pinHash") ? (String) assigned.get("pinHash") : cur.pinHash());
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
