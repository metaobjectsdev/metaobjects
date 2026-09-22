package com.metaobjects.integration.api.m2m.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.integration.api.TomcatHost;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import jakarta.validation.Validation;
import jakarta.validation.Validator;


import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.Constructor;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;


/**
 * FR-018 Unit 11 — host the GENERATED Java Spring {@code @RestController}s for the
 * shared M:N corpus ({@code Post}/{@code Person}/{@code Account}) over HTTP
 * (a real embedded Tomcat, {@link TomcatHost}) and drive the M:N traversal scenarios against them.
 *
 * <p>FW-8 (FR-018 x FR-017): {@code Account} is the TPH discriminator base
 * ({@code MemberAccount}/{@code GuestAccount} concrete subtypes, {@code ScopedAccount}
 * an abstract mid level). The generated {@code AccountController} mounts the base
 * {@code GET /{id}/badges} sub-resource UNGATED plus, per concrete subtype segment
 * ({@code /member}, {@code /guest}), every M:N relationship that subtype resolves —
 * inherited (badges), declared on the abstract mid level (scopes, only reachable
 * under {@code /member}), and declared on the subtype itself (interests) — each
 * gated by the controller's own composed {@code findByIdAndType} check (rule c).
 * {@code Post.reviewers} is the TARGET-side case: its {@code @objectRef} resolves to
 * the concrete subtype {@code MemberAccount}, so the generated {@code PostRepository}
 * seam widens with an extra {@code targetSubtype} argument (Java's repository
 * interface is consumer-implemented and cannot itself AND a discriminator into a
 * join it does not write) — narrowed by this harness's {@code InMemoryPostRepository}.
 *
 * <p>Mechanism (the SP-F generate→compile→load pattern, mirroring
 * {@code GeneratedAuthorControllerHarness}):</p>
 * <ol>
 *   <li>load {@code fixtures/api-contract-conformance/m2m/meta.json};</li>
 *   <li>run the four codegen-spring generators ({@link SpringControllerGenerator},
 *       {@link SpringDtoGenerator}, {@link SpringRepositoryGenerator},
 *       {@link SpringFilterAllowlistGenerator}) for ALL entities into a temp dir —
 *       the {@code PostController}/{@code PersonController}/{@code AccountController}
 *       emitted here (with their GENERATED {@code GET /{id}/<relation>} traversal
 *       sub-resources, {@code AccountController}'s additionally per-subtype-scoped)
 *       are the artifacts under test, hosted UNMODIFIED;</li>
 *   <li>emit the ONLY hand-written pieces — the in-memory {@code Post}/{@code Person}/
 *       {@code Account} repositories (the consumer seam behind the generated
 *       repository interfaces, traversing the junction via the runtime
 *       {@code M2mJoinResolver}) — alongside;</li>
 *   <li>compile everything with the system Java compiler; load via a child-of-test
 *       {@link URLClassLoader};</li>
 *   <li>seed the in-memory repos from {@code seed.json}, instantiate each generated
 *       controller, and serve all of them from ONE embedded Tomcat over a real socket
 *       ({@link TomcatHost}).</li>
 * </ol>
 *
 * <p>The harness is built ONCE (generate→compile→load is expensive); the
 * controllers and their Tomcat are rebuilt from a fresh seed in {@link #reset()} per scenario.</p>
 */
public final class GeneratedM2mControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.social";

    private final ObjectMapper mapper = new ObjectMapper();
    // FR-036: the generated controllers now inject a jakarta Validator (3-arg ctor).
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
    private final URLClassLoader classLoader;
    private final Map<String, List<Map<String, Object>>> seed;

    // Generated controller + interface classes + in-memory repo ctors.
    private final Constructor<?> postControllerCtor;    // (PostRepository)
    private final Constructor<?> personControllerCtor;  // (PersonRepository)
    private final Constructor<?> accountControllerCtor; // (AccountRepository) — FW-8 TPH base
    private final Constructor<?> postRepoCtor;    // (List tags, List postTags, List accounts, List postReviewers)
    private final Constructor<?> personRepoCtor;  // (List people, List follows, List friendships)
    private final Constructor<?> accountRepoCtor; // (List accounts, List tags, List accountTags, List scopedAccountTags, List memberAccountTags)
    private final Constructor<?> postCategoryControllerCtor; // (PostCategoryRepository)
    private final Constructor<?> postCategoryRepoCtor;       // (List blogCategories)

    private TomcatHost host;

    public GeneratedM2mControllerHarness(Path corpusRoot, Path genDir,
                                         Map<String, List<Map<String, Object>>> seed) throws Exception {
        this.seed = seed;
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        // 1. Load the shared M:N corpus.
        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));

        // 2. Generate controllers + DTOs + repository interfaces + filter allowlists for ALL entities.
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        // 3. Emit the hand-written in-memory consumer-seam repos.
        Path pkgDir = srcDir.resolve(ENTITY_PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("InMemoryPostRepository.java"),
            InMemoryM2mRepositorySources.POST_REPO_SOURCE);
        Files.writeString(pkgDir.resolve("InMemoryPersonRepository.java"),
            InMemoryM2mRepositorySources.PERSON_REPO_SOURCE);
        Files.writeString(pkgDir.resolve("InMemoryAccountRepository.java"),
            InMemoryM2mRepositorySources.ACCOUNT_REPO_SOURCE);
        Files.writeString(pkgDir.resolve("InMemoryPostCategoryRepository.java"),
            InMemoryM2mRepositorySources.POST_CATEGORY_REPO_SOURCE);

        // 4. Compile everything against the test classpath.
        compile(srcDir, classesDir);

        // 5. Load the compiled classes (child of the test loader so Spring + runtime types resolve).
        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());

        Class<?> postRepoIf = classLoader.loadClass(ENTITY_PKG + ".PostRepository");
        Class<?> personRepoIf = classLoader.loadClass(ENTITY_PKG + ".PersonRepository");
        Class<?> accountRepoIf = classLoader.loadClass(ENTITY_PKG + ".AccountRepository");
        this.postControllerCtor = classLoader.loadClass(ENTITY_PKG + ".PostController")
            .getDeclaredConstructor(postRepoIf, ObjectMapper.class, Validator.class);
        this.personControllerCtor = classLoader.loadClass(ENTITY_PKG + ".PersonController")
            .getDeclaredConstructor(personRepoIf, ObjectMapper.class, Validator.class);
        // FW-8: the TPH base controller takes the SAME 3-arg (repository, ObjectMapper, Validator)
        // shape as the vanilla controllers — see SpringControllerGenerator#emitTph.
        this.accountControllerCtor = classLoader.loadClass(ENTITY_PKG + ".AccountController")
            .getDeclaredConstructor(accountRepoIf, ObjectMapper.class, Validator.class);
        this.postRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.POST_FQCN)
            .getDeclaredConstructor(List.class, List.class, List.class, List.class);
        this.personRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.PERSON_FQCN)
            .getDeclaredConstructor(List.class, List.class, List.class);
        this.accountRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.ACCOUNT_FQCN)
            .getDeclaredConstructor(List.class, List.class, List.class, List.class, List.class);
        // PostCategory — no relationship; mounted so the GENERATED controller's route
        // path is exercised over HTTP, not merely asserted as a string.
        Class<?> postCategoryRepoIf = classLoader.loadClass(ENTITY_PKG + ".PostCategoryRepository");
        this.postCategoryControllerCtor = classLoader.loadClass(ENTITY_PKG + ".PostCategoryController")
            .getDeclaredConstructor(postCategoryRepoIf, ObjectMapper.class, Validator.class);
        this.postCategoryRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.POST_CATEGORY_FQCN)
            .getDeclaredConstructor(List.class);
    }

    /** Rebuild the controllers and their Tomcat from a fresh seed (per-scenario isolation). */
    public void reset() throws Exception {
        Object postRepo = postRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "tags"), M2mSeedRows.rows(seed, "post_tags"),
            M2mSeedRows.rows(seed, "accounts"), M2mSeedRows.rows(seed, "post_reviewers"));
        Object personRepo = personRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "people"), M2mSeedRows.rows(seed, "follows"),
            M2mSeedRows.rows(seed, "friendships"));
        Object accountRepo = accountRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "accounts"), M2mSeedRows.rows(seed, "tags"),
            M2mSeedRows.rows(seed, "account_tags"), M2mSeedRows.rows(seed, "scoped_account_tags"),
            M2mSeedRows.rows(seed, "member_account_tags"));

        Object postCategoryRepo = postCategoryRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "blog_categories"));

        // All four controllers on ONE server: Spring's own request mappings route between
        // them, as they would in an adopter's app.
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper,
            postControllerCtor.newInstance(postRepo, mapper, validator),
            personControllerCtor.newInstance(personRepo, mapper, validator),
            accountControllerCtor.newInstance(accountRepo, mapper, validator),
            postCategoryControllerCtor.newInstance(postCategoryRepo, mapper, validator));
    }

    /** Issue an M:N traversal request; Spring routes it to the controller owning the path. */
    public Response exchange(String method, String path) throws Exception {
        TomcatHost.Response res = host.exchange(method, path, null);
        return new Response(res.status(), res.body());
    }

    public Object parseBody(String body) {
        return TomcatHost.parseBody(mapper, body);
    }

    @Override public void close() throws Exception {
        if (host != null) host.close();
        classLoader.close();
    }

    public record Response(int status, String body) {}

    // -----------------------------------------------------------------------
    // setup helpers
    // -----------------------------------------------------------------------


    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-m2m-generated");
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }

    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new java.util.HashMap<>();
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
        if (sources.isEmpty()) throw new IllegalStateException("no generated .java sources under " + srcDir);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null)
            throw new IllegalStateException("JDK (not JRE) required — getSystemJavaCompiler() returned null");
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        // -parameters: Spring resolves @PathVariable without an explicit name= from the
        // reflective parameter name (the generated controller relies on it, as the Author lane does).
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString(), "-parameters");
        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null)
                    sb.append("    at ").append(d.getSource().getName()).append(':').append(d.getLineNumber()).append('\n');
            }
            throw new IllegalStateException(sb.toString());
        }
    }

    /** Local seed-row accessor (kept self-contained so the generated package has no test-package import). */
    private static final class M2mSeedRows {
        @SuppressWarnings("unchecked")
        static List<Map<String, Object>> rows(Map<String, List<Map<String, Object>>> seed, String table) {
            Object v = seed.get(table);
            return v == null ? List.of() : (List<Map<String, Object>>) v;
        }
    }
}
