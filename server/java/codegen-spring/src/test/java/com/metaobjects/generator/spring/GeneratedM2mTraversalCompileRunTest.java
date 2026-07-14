package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * FR-018 Unit 12 — generated-lane proof for Java M:N codegen. Boots the GENERATED
 * repository M:N traversal seam end-to-end:
 *
 * <ol>
 *   <li>load the shared {@code fixtures/api-contract-conformance/m2m/} model;</li>
 *   <li>run {@link SpringDtoGenerator} + {@link SpringRepositoryGenerator} (the
 *       generated DTOs + the {@code <Entity>Repository} interfaces with the
 *       emitted M:N finder methods) into a temp dir;</li>
 *   <li>emit an in-memory repository implementation (the consumer seam) that
 *       traverses the junction via the runtime {@code M2mJoinResolver} helper —
 *       the only hand-written piece, paralleling the SP-F
 *       {@code InMemoryAuthorRepository};</li>
 *   <li>compile all generated + seam sources with the system Java compiler and
 *       load them in a child classloader;</li>
 *   <li>seed from {@code seed.json} and invoke the GENERATED finder
 *       ({@code findTags} / {@code findFollowing} / {@code findFriends}) via
 *       reflection, asserting the related target rows match the api-contract
 *       scenarios (order-insensitive, by {@code name}).</li>
 * </ol>
 *
 * <p>The generated Spring {@code @RestController} is a one-line delegate to these
 * finders (verified by {@link SpringM2mCodegenTest}); this test drives the
 * substantive traversal artifact without pulling Spring Boot onto the
 * codegen-spring test classpath. The generated controller's HTTP lane over Spring
 * MockMvc is exercised in the {@code integration-tests} api-contract module.</p>
 */
public class GeneratedM2mTraversalCompileRunTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PKG = "acme.social";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** Walk up from cwd to find the shared api-contract m2m corpus. */
    private static Path findM2mCorpus() {
        Path cur = Paths.get("").toAbsolutePath();
        while (cur != null) {
            Path candidate = cur.resolve("fixtures/api-contract-conformance/m2m");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException("Could not locate fixtures/api-contract-conformance/m2m");
    }

    @Test
    public void generatedFindersTraverseAllThreeModes() throws Exception {
        Path corpus = findM2mCorpus();

        // 1. Load the shared model + generate DTOs + repository interfaces.
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("fx").toPath(), "m2m",
            Files.readString(corpus.resolve("meta.json"), StandardCharsets.UTF_8));

        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);

        // 2. Emit the in-memory consumer-seam repos (the only hand-written piece).
        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("InMemoryPostRepository.java"), POST_REPO_IMPL);
        Files.writeString(pkgDir.resolve("InMemoryPersonRepository.java"), PERSON_REPO_IMPL);

        // 3. Compile everything against the test classpath (M2mJoinResolver resolves there).
        compile(srcDir, classesDir);

        // 4. Load the seed rows.
        Map<String, Object> seed = MAPPER.readValue(
            Files.readString(corpus.resolve("seed.json"), StandardCharsets.UTF_8), Map.class);

        try (URLClassLoader cl = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {

            // --- hetero: Post.findTags via the generated PostRepository ---
            Object postRepo = instantiate(cl, PKG + ".InMemoryPostRepository",
                rows(seed, "tags"), rows(seed, "post_tags"));
            // post_tags = (1,10),(1,20),(2,30); tags 10=red,20=green,30=blue.
            assertNamesEqual(List.of("green", "red"), invokeFinder(postRepo, "findTags", 1L));
            assertNamesEqual(List.of("blue"), invokeFinder(postRepo, "findTags", 2L));
            assertNamesEqual(List.of(), invokeFinder(postRepo, "findTags", 3L));

            // --- directed self-join: Person.findFollowing ---
            Object personRepo = instantiate(cl, PKG + ".InMemoryPersonRepository",
                rows(seed, "people"), rows(seed, "follows"), rows(seed, "friendships"));
            // follows = (1,2),(1,3),(2,1); people 1=Alice,2=Bob,3=Carol,4=Dave.
            assertNamesEqual(List.of("Bob", "Carol"), invokeFinder(personRepo, "findFollowing", 1L));
            assertNamesEqual(List.of("Alice"), invokeFinder(personRepo, "findFollowing", 2L));
            assertNamesEqual(List.of(), invokeFinder(personRepo, "findFollowing", 3L));

            // --- symmetric self-join: Person.findFriends ---
            // friendships = (1,2),(3,1),(2,4).
            assertNamesEqual(List.of("Bob", "Carol"), invokeFinder(personRepo, "findFriends", 1L));
            assertNamesEqual(List.of("Alice", "Dave"), invokeFinder(personRepo, "findFriends", 2L));
            assertNamesEqual(List.of("Bob"), invokeFinder(personRepo, "findFriends", 4L));
        }
    }

    // -----------------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(Map<String, Object> seed, String table) {
        Object v = seed.get(table);
        return v == null ? List.of() : (List<Map<String, Object>>) v;
    }

    private static Object instantiate(URLClassLoader cl, String fqcn, Object... ctorArgs) throws Exception {
        Class<?> c = cl.loadClass(fqcn);
        Class<?>[] sig = new Class<?>[ctorArgs.length];
        for (int i = 0; i < ctorArgs.length; i++) sig[i] = List.class;
        return c.getDeclaredConstructor(sig).newInstance(ctorArgs);
    }

    /** Invoke a generated finder ({@code List<Dto> find...(Long)}) and return the result list. */
    @SuppressWarnings("unchecked")
    private static List<Object> invokeFinder(Object repo, String finder, long sourceId) throws Exception {
        Method m = repo.getClass().getMethod(finder, Long.class);
        return (List<Object>) m.invoke(repo, sourceId);
    }

    /** Assert the multiset of {@code name} record-components matches, order-insensitive. */
    private static void assertNamesEqual(List<String> expected, List<Object> actualDtos) throws Exception {
        List<String> actual = new ArrayList<>();
        for (Object dto : actualDtos) {
            Method nameAccessor = dto.getClass().getMethod("name");
            actual.add(String.valueOf(nameAccessor.invoke(dto)));
        }
        assertEquals("related-row name multiset (order-insensitive)",
            new TreeSet<>(expected), new TreeSet<>(actual));
        assertEquals("related-row count", expected.size(), actual.size());
    }

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertTrue("expected generated .java sources", !sources.isEmpty());
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required — getSystemJavaCompiler() returned null", javac);
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            fail(sb.toString());
        }
    }

    // -----------------------------------------------------------------------
    // In-memory consumer-seam repos. These implement the GENERATED repository
    // interfaces; the M:N finder bodies are the consumer's junction traversal,
    // expressed via the runtime M2mJoinResolver helper (the cross-port resolver
    // semantics). The non-M:N CRUD methods are unused by this test and stubbed.
    // -----------------------------------------------------------------------

    private static final String POST_REPO_IMPL = """
        package acme.social;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class InMemoryPostRepository implements PostRepository {
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

    private static final String PERSON_REPO_IMPL = """
        package acme.social;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class InMemoryPersonRepository implements PersonRepository {
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
