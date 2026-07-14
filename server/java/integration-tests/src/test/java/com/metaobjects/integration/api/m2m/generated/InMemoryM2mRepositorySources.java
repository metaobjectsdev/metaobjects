package com.metaobjects.integration.api.m2m.generated;

/**
 * FR-018 — the Java SOURCE for the in-memory consumer-seam repository impls
 * ({@code acme.social.InMemoryPostRepository} / {@code InMemoryPersonRepository}),
 * emitted alongside the GENERATED controllers/DTOs/repository-interfaces so they
 * compile against them, then loaded + instantiated reflectively by
 * {@link GeneratedM2mControllerHarness}.
 *
 * <p>This is the ONLY hand-written piece of the generated lane — it fills the
 * consumer seam MetaObjects intentionally leaves unimplemented (the generated
 * {@code <Entity>Repository} interface). It is <strong>test scaffolding, not a
 * conformance subject</strong>: real DB behavior is gated by
 * persistence-conformance. Its M:N finder bodies express the junction traversal
 * via the runtime {@code M2mJoinResolver} helper (the cross-port resolver
 * semantics — the same bodies the codegen-spring
 * {@code GeneratedM2mTraversalCompileRunTest} uses). The CRUD methods are unused
 * by the M:N traversal scenarios and stubbed.</p>
 *
 * <p>Kept as string constants (not real source files) so they live entirely
 * inside this test module: they reference the generated {@code acme.social.*}
 * types which only exist after codegen runs.</p>
 */
final class InMemoryM2mRepositorySources {
    private InMemoryM2mRepositorySources() {}

    static final String POST_FQCN = "acme.social.InMemoryPostRepository";
    static final String PERSON_FQCN = "acme.social.InMemoryPersonRepository";

    static final String POST_REPO_SOURCE = """
        package acme.social;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        /** Hand-written in-memory PostRepository (consumer seam). Test scaffolding only. */
        public final class InMemoryPostRepository implements PostRepository {
            private final List<TagDto> tags = new ArrayList<>();
            private final List<JunctionRow> postTags = new ArrayList<>();

            public InMemoryPostRepository(List<Map<String, Object>> tagRows,
                                          List<Map<String, Object>> postTagRows) {
                for (Map<String, Object> r : tagRows)
                    tags.add(new TagDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : postTagRows)
                    postTags.add(new JunctionRow(asLong(r.get("postId")), asLong(r.get("tagId"))));
            }

            @Override public List<TagDto> findTags(Long sourceId) {
                // hetero: junction filtered to sourceField (postId) = sourceId.
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : postTags)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<TagDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (TagDto t : tags)
                        if (M2mJoinResolver.keyEquals(t.id(), id)) out.add(t);
                return out;
            }

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            // --- unused CRUD stubs ---
            @Override public List<PostDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<PostDto> findById(Long id) { return Optional.empty(); }
            @Override public PostDto create(PostDto dto) { return dto; }
            @Override public Optional<PostDto> update(Long id, PostDto dto) { return Optional.empty(); }
            @Override public Optional<PostDto> patch(Long id, PostPatch patch) { return Optional.empty(); }
            @Override public boolean delete(Long id) { return false; }
        }
        """;

    static final String PERSON_REPO_SOURCE = """
        package acme.social;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        /** Hand-written in-memory PersonRepository (consumer seam). Test scaffolding only. */
        public final class InMemoryPersonRepository implements PersonRepository {
            private final List<PersonDto> people = new ArrayList<>();
            private final List<JunctionRow> follows = new ArrayList<>();
            private final List<JunctionRow> friendships = new ArrayList<>();

            public InMemoryPersonRepository(List<Map<String, Object>> peopleRows,
                                            List<Map<String, Object>> followRows,
                                            List<Map<String, Object>> friendshipRows) {
                for (Map<String, Object> r : peopleRows)
                    people.add(new PersonDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : followRows)
                    follows.add(new JunctionRow(asLong(r.get("followerId")), asLong(r.get("followeeId"))));
                for (Map<String, Object> r : friendshipRows)
                    friendships.add(new JunctionRow(asLong(r.get("personAId")), asLong(r.get("personBId"))));
            }

            @Override public List<PersonDto> findFollowing(Long sourceId) {
                // directed self-join: junction filtered to sourceField (followerId) = sourceId.
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : follows)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                return loadPeople(M2mJoinResolver.relatedKeys(sourceId, matched, false));
            }

            @Override public List<PersonDto> findFriends(Long sourceId) {
                // symmetric self-join: junction filtered to sourceField = id OR targetField = id.
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : friendships)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)
                            || M2mJoinResolver.keyEquals(jr.targetKey(), sourceId)) matched.add(jr);
                return loadPeople(M2mJoinResolver.relatedKeys(sourceId, matched, true));
            }

            private List<PersonDto> loadPeople(List<Object> ids) {
                List<PersonDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (PersonDto p : people)
                        if (M2mJoinResolver.keyEquals(p.id(), id)) out.add(p);
                return out;
            }

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            // --- unused CRUD stubs ---
            @Override public List<PersonDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<PersonDto> findById(Long id) { return Optional.empty(); }
            @Override public PersonDto create(PersonDto dto) { return dto; }
            @Override public Optional<PersonDto> update(Long id, PersonDto dto) { return Optional.empty(); }
            @Override public Optional<PersonDto> patch(Long id, PersonPatch patch) { return Optional.empty(); }
            @Override public boolean delete(Long id) { return false; }
        }
        """;
}
