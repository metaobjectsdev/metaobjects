package com.metaobjects.generator.spring;

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
 * FW-8 — generated-lane proof for the Java TPH x M:N repository seam. Parallels
 * {@link GeneratedM2mTraversalCompileRunTest}, but proves the two extra properties a TPH
 * hierarchy adds: (1) a base-declared M:N finder is UNSCOPED (every row of the shared
 * table is a legitimate source); (2) a subtype-scoped finder's CONTRACT — verify the
 * source id names a row of that subtype, else return an EMPTY list — is something a
 * conforming consumer implementation can actually satisfy, exercised end-to-end rather
 * than merely asserted from the generated source text.
 *
 * <p>Model: {@code Auth} (base, {@code @discriminator: type}, a plain string — the enum
 * discriminator shape is covered by {@code TphDiscriminatorEnumConformanceTest}; this test
 * is about the M:N finder contract, not discriminator typing) declares {@code tags -> Tag}
 * (hetero, base-level). {@code BridgeAuth} additionally declares its own directed
 * self-join {@code linkedAuths -> BridgeAuth} through {@code AuthLink}.</p>
 */
public class GeneratedTphM2mTraversalCompileRunTest {

    private static final String PKG = "acme.auth";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::auth", "children": [
            { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
                { "source.rdb":   { "@table": "auths" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "type", "@required": true, "@maxLength": 20 } },
                { "field.string": { "name": "reference", "@required": true, "@maxLength": 80 } },
                { "relationship.association": { "name": "tags", "@cardinality": "many",
                    "@objectRef": "Tag", "@through": "AuthTag" } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
                { "field.int": { "name": "quantity", "@required": true } },
                { "relationship.association": { "name": "linkedAuths", "@cardinality": "many",
                    "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } }
            ] } },
            { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
                { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
            ] } },
            { "object.entity": { "name": "Tag", "children": [
                { "source.rdb":   { "@table": "tags" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "name", "@required": true, "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id", "@generation": "increment" } }
            ] } },
            { "object.entity": { "name": "AuthTag", "children": [
                { "source.rdb":         { "@table": "auth_tags" } },
                { "field.long":         { "name": "authId", "@required": true } },
                { "field.long":         { "name": "tagId",  "@required": true } },
                { "identity.primary":   { "@fields": ["authId", "tagId"] } },
                { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "Auth" } },
                { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
            ] } },
            { "object.entity": { "name": "AuthLink", "children": [
                { "source.rdb":         { "@table": "auth_links" } },
                { "field.long":         { "name": "fromAuthId", "@required": true } },
                { "field.long":         { "name": "toAuthId",   "@required": true } },
                { "identity.primary":   { "@fields": ["fromAuthId", "toAuthId"] } },
                { "identity.reference": { "name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
                { "identity.reference": { "name": "fkTo",   "@fields": "toAuthId",   "@references": "BridgeAuth" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void generatedTphFindersEnforceBaseWideAndSubtypeScopedContracts() throws Exception {
        Path srcDir = tmp.newFolder("src").toPath();
        Path classesDir = tmp.newFolder("classes").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx").toPath(), "tph-m2m", FIXTURE);

        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("InMemoryAuthRepository.java"), AUTH_REPO_IMPL);

        compile(srcDir, classesDir);

        Map<String, Object> seed = Map.of(
            "auths", List.of(
                Map.of("id", 1, "type", "Bridge", "reference", "b1"),
                Map.of("id", 2, "type", "Copay", "reference", "c1")),
            "tags", List.of(Map.of("id", 10, "name", "red"), Map.of("id", 20, "name", "green")),
            // auth 1 (Bridge) -> tag 10; auth 2 (Copay) -> tag 20.
            "auth_tags", List.of(Map.of("authId", 1, "tagId", 10), Map.of("authId", 2, "tagId", 20)),
            // auth 1 (Bridge) links to auth 2 — a hetero-looking row, but AuthLink only
            // ever references BridgeAuth ids on both sides by the fixture's own FK.
            "auth_links", List.of(Map.of("fromAuthId", 1, "toAuthId", 1)));

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Object repo = instantiate(cl, PKG + ".InMemoryAuthRepository",
                rows(seed, "auths"), rows(seed, "tags"), rows(seed, "auth_tags"), rows(seed, "auth_links"));

            // Rule (a): a base-declared relationship's finder is UNSCOPED — every row,
            // Bridge or Copay, is a legitimate source.
            assertNamesEqual(List.of("red"), invokeFinder(repo, "findTags", 1L));
            assertNamesEqual(List.of("green"), invokeFinder(repo, "findTags", 2L));

            // Rule (b)+(c): the Bridge-scoped finder answers for a REAL Bridge id...
            assertNamesEqual(List.of("red"), invokeFinder(repo, "findTagsForBridge", 1L));
            // ...and returns EMPTY — not the sibling's rows, not an exception — for a
            // Copay id, because the junction FK cannot itself distinguish the subtypes.
            assertNamesEqual(List.of(), invokeFinder(repo, "findTagsForBridge", 2L));
            // Symmetric proof on the Copay-scoped finder.
            assertNamesEqual(List.of("green"), invokeFinder(repo, "findTagsForCopay", 2L));
            assertNamesEqual(List.of(), invokeFinder(repo, "findTagsForCopay", 1L));

            // Subtype-OWN relationship (linkedAuths, self-join on BridgeAuth): resolves for
            // a real Bridge id, empty for the Copay id.
            assertReferencesEqual(List.of("b1"), invokeFinder(repo, "findLinkedAuthsForBridge", 1L));
            assertReferencesEqual(List.of(), invokeFinder(repo, "findLinkedAuthsForBridge", 2L));
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

    /** Assert the multiset of {@code reference} record-components matches (AuthDto rows). */
    private static void assertReferencesEqual(List<String> expected, List<Object> actualDtos) throws Exception {
        List<String> actual = new ArrayList<>();
        for (Object dto : actualDtos) {
            Method refAccessor = dto.getClass().getMethod("reference");
            actual.add(String.valueOf(refAccessor.invoke(dto)));
        }
        assertEquals("related-row reference multiset (order-insensitive)",
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
    // In-memory consumer-seam repo. The M:N finder bodies are the consumer's junction
    // traversal + subtype-membership check — the contract SpringRepositoryGenerator's
    // javadoc on each per-subtype finder describes. Non-M:N CRUD is unused, stubbed.
    // -----------------------------------------------------------------------

    private static final String AUTH_REPO_IMPL = """
        package acme.auth;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class InMemoryAuthRepository implements AuthRepository {
            private final List<AuthDto> auths = new ArrayList<>();
            private final List<TagDto> tags = new ArrayList<>();
            private final List<JunctionRow> authTags = new ArrayList<>();
            private final List<JunctionRow> authLinks = new ArrayList<>();

            public InMemoryAuthRepository(List<Map<String, Object>> authRows,
                                          List<Map<String, Object>> tagRows,
                                          List<Map<String, Object>> authTagRows,
                                          List<Map<String, Object>> authLinkRows) {
                for (Map<String, Object> r : authRows)
                    auths.add(new AuthDto(asLong(r.get("id")), (String) r.get("type"),
                        (String) r.get("reference"), null, null));
                for (Map<String, Object> r : tagRows)
                    tags.add(new TagDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : authTagRows)
                    authTags.add(new JunctionRow(asLong(r.get("authId")), asLong(r.get("tagId"))));
                for (Map<String, Object> r : authLinkRows)
                    authLinks.add(new JunctionRow(asLong(r.get("fromAuthId")), asLong(r.get("toAuthId"))));
            }

            // Rule (a): base-declared "tags" — no discriminator check, every row qualifies.
            @Override public List<TagDto> findTags(Long sourceId) {
                return tagsFor(sourceId);
            }

            // Rule (b)+(c): subtype-scoped "tags" — verify sourceId names a Bridge row first.
            @Override public List<TagDto> findTagsForBridge(Long sourceId) {
                return isType(sourceId, "Bridge") ? tagsFor(sourceId) : List.of();
            }

            @Override public List<TagDto> findTagsForCopay(Long sourceId) {
                return isType(sourceId, "Copay") ? tagsFor(sourceId) : List.of();
            }

            // Subtype-OWN "linkedAuths" (directed self-join through AuthLink). The relationship's
            // @objectRef names BridgeAuth itself, so the repository's finder is DTO-typed to the
            // subtype's own standalone BridgeAuthDto (Java emits one per TPH subtype for exactly
            // this reason — see SpringDtoGenerator), unlike Kotlin's target-redirection (FW-3),
            // which has no such standalone subtype type to bind to.
            @Override public List<BridgeAuthDto> findLinkedAuthsForBridge(Long sourceId) {
                if (!isType(sourceId, "Bridge")) return List.of();
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : authLinks)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<BridgeAuthDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (AuthDto a : auths)
                        if (M2mJoinResolver.keyEquals(a.id(), id)) {
                            out.add(new BridgeAuthDto(0, a.id(), a.type(), a.reference()));
                        }
                return out;
            }

            private List<TagDto> tagsFor(Long sourceId) {
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : authTags)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<TagDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (TagDto t : tags)
                        if (M2mJoinResolver.keyEquals(t.id(), id)) out.add(t);
                return out;
            }

            private boolean isType(Long sourceId, String type) {
                for (AuthDto a : auths)
                    if (M2mJoinResolver.keyEquals(a.id(), sourceId)) return type.equals(a.type());
                return false;
            }

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            // --- unused CRUD stubs ---
            @Override public List<AuthDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<AuthDto> findById(Long id) { return Optional.empty(); }
            @Override public List<AuthDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public Optional<AuthDto> findByIdAndType(Long id, String discriminator) { return Optional.empty(); }
            @Override public AuthDto createWithType(String discriminator, AuthDto dto) { return dto; }
            @Override public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) { return Optional.empty(); }
            @Override public Optional<AuthDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;
}
