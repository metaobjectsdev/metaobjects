package com.metaobjects.integration.api.m2m.generated;

/**
 * FR-018 — the Java SOURCE for the in-memory consumer-seam repository impls
 * ({@code acme.social.InMemoryPostRepository} / {@code InMemoryPersonRepository} /
 * {@code InMemoryAccountRepository}), emitted alongside the GENERATED
 * controllers/DTOs/repository-interfaces so they compile against them, then
 * loaded + instantiated reflectively by {@link GeneratedM2mControllerHarness}.
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
 * <p>FW-8 (FR-018 x FR-017 — TPH x M:N): {@code InMemoryAccountRepository} backs the
 * TPH discriminator base {@code Account}'s repository seam. Rule (c) — a
 * subtype-scoped mount answers {@code []} for an id that does not name a row of
 * that subtype — is enforced by the GENERATED {@code AccountController} itself
 * (it composes {@code repository.findByIdAndType(id, discriminator)} BEFORE ever
 * calling a per-subtype M:N finder; see {@code SpringControllerGenerator#emitTph}),
 * so {@code findByIdAndType} below must be correct but the per-subtype finders
 * need not re-check subtype membership. {@code InMemoryPostRepository.findReviewers}
 * is the TARGET-side gate: {@code Post.reviewers} resolves onto the concrete TPH
 * subtype {@code MemberAccount}, so the widened repository seam (an extra
 * {@code targetSubtype} argument — Java's repository interface is
 * consumer-implemented and cannot itself AND a discriminator into a join it does
 * not write) is where this harness narrows the joined rows to {@code kind ==
 * targetSubtype}.</p>
 *
 * <p>Kept as string constants (not real source files) so they live entirely
 * inside this test module: they reference the generated {@code acme.social.*}
 * types which only exist after codegen runs.</p>
 */
final class InMemoryM2mRepositorySources {
    private InMemoryM2mRepositorySources() {}

    static final String POST_FQCN = "acme.social.InMemoryPostRepository";
    static final String PERSON_FQCN = "acme.social.InMemoryPersonRepository";
    static final String ACCOUNT_FQCN = "acme.social.InMemoryAccountRepository";

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
            // FW-8 target-side: reviewers -> MemberAccount (a TPH subtype). Only the Member rows
            // are kept here (the seam's targetSubtype argument is always the resolved "Member"
            // literal by construction — see SpringM2mSupport.M2mNav.targetDiscriminatorValue), so
            // findReviewers filters by kind at construction time rather than per call.
            private final List<MemberAccountDto> members = new ArrayList<>();
            private final List<JunctionRow> postReviewers = new ArrayList<>();

            public InMemoryPostRepository(List<Map<String, Object>> tagRows,
                                          List<Map<String, Object>> postTagRows,
                                          List<Map<String, Object>> accountRows,
                                          List<Map<String, Object>> postReviewerRows) {
                for (Map<String, Object> r : tagRows)
                    tags.add(new TagDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : postTagRows)
                    postTags.add(new JunctionRow(asLong(r.get("postId")), asLong(r.get("tagId"))));
                for (Map<String, Object> r : accountRows) {
                    if (!"Member".equals(r.get("kind"))) continue; // rule: target-side TPH narrowing
                    Integer karma = r.get("karma") == null ? null : ((Number) r.get("karma")).intValue();
                    members.add(new MemberAccountDto(karma, asLong(r.get("id")),
                        MemberAccountDto.MemberAccountKind.valueOf((String) r.get("kind")),
                        (String) r.get("handle")));
                }
                for (Map<String, Object> r : postReviewerRows)
                    postReviewers.add(new JunctionRow(asLong(r.get("postId")), asLong(r.get("accountId"))));
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

            @Override public List<MemberAccountDto> findReviewers(Long sourceId, String targetSubtype) {
                // FW-8 target side: post_reviewers deliberately links some posts to a Guest
                // account too (a same-table sibling) — `members` above already excludes every
                // row whose kind != targetSubtype, so a Guest id never surfaces here.
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : postReviewers)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<MemberAccountDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (MemberAccountDto a : members)
                        if (M2mJoinResolver.keyEquals(a.id(), id)) out.add(a);
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

    // FW-8 (FR-018 x FR-017): the TPH discriminator base's repository seam. See the class
    // javadoc above for the rule (c) / target-side-gate split.
    static final String ACCOUNT_REPO_SOURCE = """
        package acme.social;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        /** Hand-written in-memory AccountRepository (TPH consumer seam). Test scaffolding only. */
        public final class InMemoryAccountRepository implements AccountRepository {
            private final List<AccountDto> accounts = new ArrayList<>();
            private final List<TagDto> tags = new ArrayList<>();
            private final List<JunctionRow> badgesJunction = new ArrayList<>();     // account_tags
            private final List<JunctionRow> scopesJunction = new ArrayList<>();     // scoped_account_tags
            private final List<JunctionRow> interestsJunction = new ArrayList<>();  // member_account_tags

            public InMemoryAccountRepository(List<Map<String, Object>> accountRows,
                                             List<Map<String, Object>> tagRows,
                                             List<Map<String, Object>> accountTagRows,
                                             List<Map<String, Object>> scopedAccountTagRows,
                                             List<Map<String, Object>> memberAccountTagRows) {
                for (Map<String, Object> r : accountRows) {
                    Integer karma = r.get("karma") == null ? null : ((Number) r.get("karma")).intValue();
                    accounts.add(new AccountDto(asLong(r.get("id")),
                        r.get("kind") == null ? null : AccountDto.AccountKind.valueOf((String) r.get("kind")),
                        (String) r.get("handle"), (String) r.get("invitedBy"), karma));
                }
                for (Map<String, Object> r : tagRows)
                    tags.add(new TagDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : accountTagRows)
                    badgesJunction.add(new JunctionRow(asLong(r.get("accountId")), asLong(r.get("tagId"))));
                for (Map<String, Object> r : scopedAccountTagRows)
                    scopesJunction.add(new JunctionRow(asLong(r.get("accountId")), asLong(r.get("tagId"))));
                for (Map<String, Object> r : memberAccountTagRows)
                    interestsJunction.add(new JunctionRow(asLong(r.get("accountId")), asLong(r.get("tagId"))));
            }

            // --- M:N: rule (a), base-declared, whole-table (no subtype gate) ---
            @Override public List<TagDto> findBadges(Long sourceId) { return joinTags(sourceId, badgesJunction); }

            // --- M:N: rule (b)/(c), per-subtype — the GENERATED AccountController already
            // verifies sourceId names a row of this subtype (via findByIdAndType) BEFORE ever
            // calling these, so no membership re-check is needed here (belt-and-braces was
            // deliberately left to the controller, not duplicated in every finder body). ---
            @Override public List<TagDto> findBadgesForMember(Long sourceId) { return joinTags(sourceId, badgesJunction); }
            @Override public List<TagDto> findBadgesForGuest(Long sourceId) { return joinTags(sourceId, badgesJunction); }
            @Override public List<TagDto> findScopesForMember(Long sourceId) { return joinTags(sourceId, scopesJunction); }
            @Override public List<TagDto> findInterestsForMember(Long sourceId) { return joinTags(sourceId, interestsJunction); }

            private List<TagDto> joinTags(Long sourceId, List<JunctionRow> junction) {
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : junction)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<TagDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (TagDto t : tags)
                        if (M2mJoinResolver.keyEquals(t.id(), id)) out.add(t);
                return out;
            }

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            // --- polymorphic CRUD (unused by the M:N traversal scenarios) ---
            @Override public List<AccountDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<AccountDto> findById(Long id) {
                for (AccountDto a : accounts) if (id.equals(a.id())) return Optional.of(a);
                return Optional.empty();
            }

            // --- per-subtype CRUD — findByIdAndType MUST be correct: the generated
            // controller's subtype-scoped M:N routes gate on it (rule c). The others are
            // unused by the M:N traversal scenarios and stubbed. ---
            @Override public List<AccountDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public Optional<AccountDto> findByIdAndType(Long id, String discriminator) {
                for (AccountDto a : accounts)
                    if (id.equals(a.id()) && a.kind() != null && discriminator.equals(a.kind().name())) return Optional.of(a);
                return Optional.empty();
            }
            @Override public AccountDto createWithType(String discriminator, AccountDto dto) { return dto; }
            @Override public Optional<AccountDto> updateByIdAndType(Long id, String discriminator, AccountDto dto) { return Optional.empty(); }
            @Override public Optional<AccountDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;
}
