package com.metaobjects.generator.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.loader.MetaDataLoader;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.springframework.http.ResponseEntity;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Constructor;
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
            // a real Bridge id, empty for the Copay id. The target — BridgeAuth itself — is
            // ALSO a concrete TPH subtype, so the finder now takes the build-time-resolved
            // "Bridge" literal as a second argument (FW-8 follow-up, target-side gate).
            assertReferencesEqual(List.of("b1"), invokeFinderWithSubtype(repo, "findLinkedAuthsForBridge", 1L, "Bridge"));
            assertReferencesEqual(List.of(), invokeFinderWithSubtype(repo, "findLinkedAuthsForBridge", 2L, "Bridge"));
        }
    }

    /**
     * The target-side counterpart to
     * {@link #generatedControllerEnforcesTheGateEvenWhenTheRepositoryDoesNotFilter}: proves the
     * {@code targetSubtype} literal is genuinely THREADED end-to-end — codegen resolves it at
     * build time, the generated controller passes it at the call site, and a repository
     * implementation that actually USES it to filter the join returns only rows of that
     * subtype, never a same-table sibling's. {@code linkedAuths}' {@code @objectRef} names
     * {@code BridgeAuth} — a concrete TPH subtype of {@code Auth} — so its rows physically
     * share the {@code auths} table with {@code CopayAuth} rows; nothing in the junction FK
     * itself (a plain {@code Long} id) can distinguish them. Unlike the SOURCE-side rule (c),
     * Java's generated controller CANNOT enforce this itself (the join is entirely
     * consumer-owned) — the seam can only be WIDENED so a conforming implementation has what
     * it needs, exactly the same limitation the Python port documents for its own
     * {@code target_subtype} parameter. This test's junction data is deliberately corrupted
     * (a link row pointing at a same-table Copay row) to prove a conforming, FILTERING
     * repository correctly excludes it once it is handed {@code "Bridge"}.
     */
    @Test
    public void generatedControllerThreadsTheResolvedTargetDiscriminatorLiteralToAFilteringRepository() throws Exception {
        Path srcDir = tmp.newFolder("src3").toPath();
        Path classesDir = tmp.newFolder("classes3").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx3").toPath(), "tph-m2m-target-3", FIXTURE);

        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("FilteringAuthRepository.java"), FILTERING_AUTH_REPO_IMPL);

        compile(srcDir, classesDir);

        Map<String, Object> seed = Map.of(
            "auths", List.of(
                Map.of("id", 1, "type", "Bridge", "reference", "b1"),
                Map.of("id", 2, "type", "Copay", "reference", "c1")),
            "tags", List.of(),
            "auth_tags", List.of(),
            // auth 1 (Bridge) links to itself (a GENUINE Bridge target) AND — a corrupted row
            // that should never exist under a correctly-enforced physical schema — to auth 2,
            // whose type is Copay. Nothing in the junction FK's plain Long id distinguishes them.
            "auth_links", List.of(
                Map.of("fromAuthId", 1, "toAuthId", 1),
                Map.of("fromAuthId", 1, "toAuthId", 2)));

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Object repo = instantiate(cl, PKG + ".FilteringAuthRepository",
                rows(seed, "auths"), rows(seed, "tags"), rows(seed, "auth_tags"), rows(seed, "auth_links"));

            Class<?> repoIface = cl.loadClass(PKG + ".AuthRepository");
            Class<?> controllerClass = cl.loadClass(PKG + ".AuthController");
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
            Constructor<?> ctor = controllerClass.getDeclaredConstructor(repoIface, ObjectMapper.class, Validator.class);
            Object controller = ctor.newInstance(repo, new ObjectMapper(), validator);

            // Direct repository call: the FILTERING implementation excludes the corrupted
            // Copay-typed target even though the junction row itself does not.
            assertReferencesEqual(List.of("b1"),
                invokeFinderWithSubtype(repo, "findLinkedAuthsForBridge", 1L, "Bridge"));

            // Through the GENERATED CONTROLLER — the exact call site codegen now emits,
            // repository.findLinkedAuthsForBridge(id, "Bridge") — the same clean result.
            ResponseEntity<?> resp = invokeControllerFinder(controller, "findLinkedAuthsForBridge", 1L);
            assertEquals(200, resp.getStatusCode().value());
            List<Object> body = (List<Object>) resp.getBody();
            assertReferencesEqual(List.of("b1"), body);
        }
    }

    /**
     * The distinguishing test: enforcement, not delegation. {@link NaiveAuthRepository}'s
     * {@code findTagsForBridge}/{@code findTagsForCopay} are a copy-paste of the UNSCOPED
     * {@code findTags} — no discriminator check at all — which javac, the repository
     * interface's type system, and a corpus scenario against a delegating port all wave
     * through. Only the GENERATED CONTROLLER's own composition of
     * {@code repository.findByIdAndType(id, "<disc>")} (the exact seam the per-subtype GET
     * already depends on) stands between that bug and a sibling subtype's rows leaking out at
     * HTTP 200. This test instantiates the ACTUAL GENERATED {@code AuthController} — no Spring
     * context, no HTTP dispatch, just the emitted Java object — wired to the naive repository,
     * and proves the controller still returns {@code []} for a mismatched id. Delete the
     * {@code findByIdAndType} composition from {@code SpringControllerGenerator#emitTph} and
     * this test fails (the naive repo answers directly, non-empty).
     */
    @Test
    public void generatedControllerEnforcesTheGateEvenWhenTheRepositoryDoesNotFilter() throws Exception {
        Path srcDir = tmp.newFolder("src2").toPath();
        Path classesDir = tmp.newFolder("classes2").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(tmp.newFolder("fx2").toPath(), "tph-m2m-2", FIXTURE);

        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        // FilterAllowlist / SortAllowlist / FilterParser support types the controller imports.
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path pkgDir = srcDir.resolve(PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("NaiveAuthRepository.java"), NAIVE_AUTH_REPO_IMPL);

        compile(srcDir, classesDir);

        Map<String, Object> seed = Map.of(
            "auths", List.of(
                Map.of("id", 1, "type", "Bridge", "reference", "b1"),
                Map.of("id", 2, "type", "Copay", "reference", "c1")),
            "tags", List.of(Map.of("id", 10, "name", "red"), Map.of("id", 20, "name", "green")),
            "auth_tags", List.of(Map.of("authId", 1, "tagId", 10), Map.of("authId", 2, "tagId", 20)));

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Object naiveRepo = instantiate(cl, PKG + ".NaiveAuthRepository",
                rows(seed, "auths"), rows(seed, "tags"), rows(seed, "auth_tags"));

            Class<?> repoIface = cl.loadClass(PKG + ".AuthRepository");
            Class<?> controllerClass = cl.loadClass(PKG + ".AuthController");
            Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
            Constructor<?> ctor = controllerClass.getDeclaredConstructor(repoIface, ObjectMapper.class, Validator.class);
            Object controller = ctor.newInstance(naiveRepo, new ObjectMapper(), validator);

            // A REAL Bridge id: findByIdAndType finds it, the controller proceeds to the
            // (naive, but here harmlessly correct for its OWN id) finder.
            ResponseEntity<?> bridgeResp = invokeControllerFinder(controller, "findTagsForBridge", 1L);
            assertEquals(200, bridgeResp.getStatusCode().value());
            assertNamesEqual(List.of("red"), (List<Object>) bridgeResp.getBody());

            // The Copay id: NaiveAuthRepository.findTagsForBridge would happily return the
            // Copay's OWN tags (["green"]) if the controller ever called it — it has no
            // discriminator check of its own. It must NOT be called: the controller's
            // findByIdAndType(2, "Bridge") composition returns empty first, short-circuiting
            // to [] before the naive finder runs.
            ResponseEntity<?> mismatchResp = invokeControllerFinder(controller, "findTagsForBridge", 2L);
            assertEquals(200, mismatchResp.getStatusCode().value());
            assertNamesEqual(List.of(), (List<Object>) mismatchResp.getBody());

            // Mirror on the Copay-scoped finder with the Bridge id.
            ResponseEntity<?> mismatchResp2 = invokeControllerFinder(controller, "findTagsForCopay", 1L);
            assertEquals(200, mismatchResp2.getStatusCode().value());
            assertNamesEqual(List.of(), (List<Object>) mismatchResp2.getBody());
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

    /** Invoke a widened (target-subtype-carrying) M:N finder: {@code (Long, String)}. */
    @SuppressWarnings("unchecked")
    private static List<Object> invokeFinderWithSubtype(
            Object repo, String finder, long sourceId, String targetSubtype) throws Exception {
        Method m = repo.getClass().getMethod(finder, Long.class, String.class);
        return (List<Object>) m.invoke(repo, sourceId, targetSubtype);
    }

    /** Invoke a generated controller's M:N handler ({@code ResponseEntity<List<Dto>> x(Long)}). */
    private static ResponseEntity<?> invokeControllerFinder(Object controller, String finder, long sourceId) throws Exception {
        Method m = controller.getClass().getMethod(finder, Long.class);
        return (ResponseEntity<?>) m.invoke(controller, sourceId);
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
            // which has no such standalone subtype type to bind to. BridgeAuth is ITSELF a TPH
            // subtype, so the finder also carries the build-time-resolved targetSubtype literal
            // (FW-8 follow-up); this impl does not filter on it (that is proven separately by
            // FilteringAuthRepository below) — it is accepted here purely to satisfy the widened
            // interface.
            @Override public List<BridgeAuthDto> findLinkedAuthsForBridge(Long sourceId, String targetSubtype) {
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
            @Override public Optional<AuthDto> findByIdAndType(Long id, String discriminator) {
                for (AuthDto a : auths)
                    if (M2mJoinResolver.keyEquals(a.id(), id) && discriminator.equals(a.type())) return Optional.of(a);
                return Optional.empty();
            }
            @Override public AuthDto createWithType(String discriminator, AuthDto dto) { return dto; }
            @Override public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) { return Optional.empty(); }
            @Override public Optional<AuthDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;

    // -----------------------------------------------------------------------
    // A DELIBERATELY BUGGY consumer-seam repo: findByIdAndType is correct (the same
    // per-subtype GET contract every consumer must already satisfy), but the M:N finders
    // are a copy-paste of the UNSCOPED base finder — no discriminator check at all. This is
    // exactly the shape javac and the repository interface's own type system cannot reject
    // (see GeneratedTphM2mTraversalCompileRunTest's controllerEnforces... test): only the
    // GENERATED CONTROLLER's composition of findByIdAndType stands between this bug and a
    // sibling subtype's rows leaking out at 200.
    // -----------------------------------------------------------------------

    private static final String NAIVE_AUTH_REPO_IMPL = """
        package acme.auth;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class NaiveAuthRepository implements AuthRepository {
            private final List<AuthDto> auths = new ArrayList<>();
            private final List<TagDto> tags = new ArrayList<>();
            private final List<JunctionRow> authTags = new ArrayList<>();

            public NaiveAuthRepository(List<Map<String, Object>> authRows,
                                       List<Map<String, Object>> tagRows,
                                       List<Map<String, Object>> authTagRows) {
                for (Map<String, Object> r : authRows)
                    auths.add(new AuthDto(asLong(r.get("id")), (String) r.get("type"),
                        (String) r.get("reference"), null, null));
                for (Map<String, Object> r : tagRows)
                    tags.add(new TagDto(asLong(r.get("id")), (String) r.get("name")));
                for (Map<String, Object> r : authTagRows)
                    authTags.add(new JunctionRow(asLong(r.get("authId")), asLong(r.get("tagId"))));
            }

            @Override public List<TagDto> findTags(Long sourceId) { return tagsFor(sourceId); }

            // BUG: a copy-paste of findTags — no discriminator check. A conforming consumer
            // must not ship this, but nothing except the generated controller's own gate
            // stops it from doing so and still passing every OTHER test.
            @Override public List<TagDto> findTagsForBridge(Long sourceId) { return tagsFor(sourceId); }
            @Override public List<TagDto> findTagsForCopay(Long sourceId) { return tagsFor(sourceId); }
            @Override public List<BridgeAuthDto> findLinkedAuthsForBridge(Long sourceId, String targetSubtype) { return List.of(); }

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

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            // findByIdAndType is CORRECT — the same seam the per-subtype GET already relies on,
            // and the one the generated controller's M:N gate now composes.
            @Override public Optional<AuthDto> findByIdAndType(Long id, String discriminator) {
                for (AuthDto a : auths)
                    if (M2mJoinResolver.keyEquals(a.id(), id) && discriminator.equals(a.type())) return Optional.of(a);
                return Optional.empty();
            }

            // --- unused CRUD stubs ---
            @Override public List<AuthDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<AuthDto> findById(Long id) { return Optional.empty(); }
            @Override public List<AuthDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public AuthDto createWithType(String discriminator, AuthDto dto) { return dto; }
            @Override public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) { return Optional.empty(); }
            @Override public Optional<AuthDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;

    // -----------------------------------------------------------------------
    // A CONFORMING consumer-seam repo for the target-side gate: unlike AUTH_REPO_IMPL
    // (which accepts-but-ignores targetSubtype) and NAIVE_AUTH_REPO_IMPL (which
    // ignores the SOURCE-side gate), this implementation actually USES the widened
    // targetSubtype argument to filter the join — exactly what a real adopter must
    // do, since MetaObjects hands the literal but cannot itself enforce it (the join
    // is entirely consumer-owned). Proves the seam is not merely present but
    // genuinely load-bearing.
    // -----------------------------------------------------------------------

    private static final String FILTERING_AUTH_REPO_IMPL = """
        package acme.auth;

        import com.metaobjects.generator.spring.runtime.FilterPredicate;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver;
        import com.metaobjects.generator.spring.runtime.M2mJoinResolver.JunctionRow;
        import java.util.ArrayList;
        import java.util.List;
        import java.util.Map;
        import java.util.Optional;

        public class FilteringAuthRepository implements AuthRepository {
            private final List<AuthDto> auths = new ArrayList<>();
            private final List<TagDto> tags = new ArrayList<>();
            private final List<JunctionRow> authTags = new ArrayList<>();
            private final List<JunctionRow> authLinks = new ArrayList<>();

            public FilteringAuthRepository(List<Map<String, Object>> authRows,
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

            @Override public List<TagDto> findTags(Long sourceId) { return List.of(); }
            @Override public List<TagDto> findTagsForBridge(Long sourceId) { return List.of(); }
            @Override public List<TagDto> findTagsForCopay(Long sourceId) { return List.of(); }

            // The load-bearing method: filters the joined targets down to rows whose OWN
            // discriminator matches the literal the generated controller now hands in —
            // excluding a same-table sibling the junction FK alone cannot distinguish.
            @Override public List<BridgeAuthDto> findLinkedAuthsForBridge(Long sourceId, String targetSubtype) {
                if (!isType(sourceId, "Bridge")) return List.of();
                List<JunctionRow> matched = new ArrayList<>();
                for (JunctionRow jr : authLinks)
                    if (M2mJoinResolver.keyEquals(jr.sourceKey(), sourceId)) matched.add(jr);
                List<Object> ids = M2mJoinResolver.relatedKeys(sourceId, matched, false);
                List<BridgeAuthDto> out = new ArrayList<>();
                for (Object id : ids)
                    for (AuthDto a : auths)
                        if (M2mJoinResolver.keyEquals(a.id(), id) && targetSubtype.equals(a.type())) {
                            out.add(new BridgeAuthDto(0, a.id(), a.type(), a.reference()));
                        }
                return out;
            }

            private boolean isType(Long sourceId, String type) {
                for (AuthDto a : auths)
                    if (M2mJoinResolver.keyEquals(a.id(), sourceId)) return type.equals(a.type());
                return false;
            }

            private static Long asLong(Object o) { return o == null ? null : ((Number) o).longValue(); }

            @Override public Optional<AuthDto> findByIdAndType(Long id, String discriminator) {
                for (AuthDto a : auths)
                    if (M2mJoinResolver.keyEquals(a.id(), id) && discriminator.equals(a.type())) return Optional.of(a);
                return Optional.empty();
            }

            // --- unused CRUD stubs ---
            @Override public List<AuthDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public long count(List<FilterPredicate> f) { return 0; }
            @Override public Optional<AuthDto> findById(Long id) { return Optional.empty(); }
            @Override public List<AuthDto> listByType(String discriminator, int limit, int offset, SortClause sort, List<FilterPredicate> f) { return List.of(); }
            @Override public AuthDto createWithType(String discriminator, AuthDto dto) { return dto; }
            @Override public Optional<AuthDto> updateByIdAndType(Long id, String discriminator, AuthDto dto) { return Optional.empty(); }
            @Override public Optional<AuthDto> patchByIdAndType(Long id, String discriminator, Map<String, Object> assigned) { return Optional.empty(); }
            @Override public boolean deleteByIdAndType(Long id, String discriminator) { return false; }
        }
        """;
}
