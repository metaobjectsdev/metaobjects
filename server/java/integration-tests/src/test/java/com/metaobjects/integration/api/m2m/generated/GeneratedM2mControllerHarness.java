package com.metaobjects.integration.api.m2m.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import jakarta.validation.Validation;
import jakarta.validation.Validator;

import org.springframework.http.HttpMethod;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

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

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * FR-018 Unit 11 — host the GENERATED Java Spring {@code @RestController}s for the
 * shared M:N corpus ({@code Post}/{@code Person}) over HTTP (in-process via Spring
 * MockMvc) and drive the M:N traversal scenarios against them.
 *
 * <p>Mechanism (the SP-F generate→compile→load pattern, mirroring
 * {@code GeneratedAuthorControllerHarness}):</p>
 * <ol>
 *   <li>load {@code fixtures/api-contract-conformance/m2m/meta.json};</li>
 *   <li>run the four codegen-spring generators ({@link SpringControllerGenerator},
 *       {@link SpringDtoGenerator}, {@link SpringRepositoryGenerator},
 *       {@link SpringFilterAllowlistGenerator}) for ALL six entities into a temp dir —
 *       the {@code PostController}/{@code PersonController} emitted here (with their
 *       GENERATED {@code GET /{id}/<relation>} traversal sub-resources) are the
 *       artifacts under test, hosted UNMODIFIED;</li>
 *   <li>emit the ONLY hand-written pieces — the in-memory {@code Post}/{@code Person}
 *       repositories (the consumer seam behind the generated repository interfaces,
 *       traversing the junction via the runtime {@code M2mJoinResolver}) — alongside;</li>
 *   <li>compile everything with the system Java compiler; load via a child-of-test
 *       {@link URLClassLoader};</li>
 *   <li>seed the in-memory repos from {@code seed.json}, instantiate each generated
 *       controller, and host on a {@code MockMvc} {@code standaloneSetup} (no Spring
 *       Boot context, no socket).</li>
 * </ol>
 *
 * <p>The harness is built ONCE (generate→compile→load is expensive); both controllers'
 * MockMvc are rebuilt from a fresh seed in {@link #reset()} per scenario.</p>
 */
public final class GeneratedM2mControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.social";

    private final ObjectMapper mapper = new ObjectMapper();
    // FR-036: the generated controllers now inject a jakarta Validator (3-arg ctor).
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();
    private final URLClassLoader classLoader;
    private final Map<String, List<Map<String, Object>>> seed;

    // Generated controller + interface classes + in-memory repo ctors.
    private final Constructor<?> postControllerCtor;   // (PostRepository)
    private final Constructor<?> personControllerCtor; // (PersonRepository)
    private final Constructor<?> postRepoCtor;         // (List tags, List postTags)
    private final Constructor<?> personRepoCtor;       // (List people, List follows, List friendships)

    private MockMvc postMvc;
    private MockMvc personMvc;

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

        // 4. Compile everything against the test classpath.
        compile(srcDir, classesDir);

        // 5. Load the compiled classes (child of the test loader so Spring + runtime types resolve).
        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());

        Class<?> postRepoIf = classLoader.loadClass(ENTITY_PKG + ".PostRepository");
        Class<?> personRepoIf = classLoader.loadClass(ENTITY_PKG + ".PersonRepository");
        this.postControllerCtor = classLoader.loadClass(ENTITY_PKG + ".PostController")
            .getDeclaredConstructor(postRepoIf, ObjectMapper.class, Validator.class);
        this.personControllerCtor = classLoader.loadClass(ENTITY_PKG + ".PersonController")
            .getDeclaredConstructor(personRepoIf, ObjectMapper.class, Validator.class);
        this.postRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.POST_FQCN)
            .getDeclaredConstructor(List.class, List.class);
        this.personRepoCtor = classLoader.loadClass(InMemoryM2mRepositorySources.PERSON_FQCN)
            .getDeclaredConstructor(List.class, List.class, List.class);
    }

    /** Rebuild both controllers' MockMvc from a fresh seed (per-scenario isolation). */
    public void reset() throws Exception {
        Object postRepo = postRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "tags"), M2mSeedRows.rows(seed, "post_tags"));
        Object personRepo = personRepoCtor.newInstance(
            M2mSeedRows.rows(seed, "people"), M2mSeedRows.rows(seed, "follows"),
            M2mSeedRows.rows(seed, "friendships"));

        this.postMvc = standalone(postControllerCtor.newInstance(postRepo, mapper, validator));
        this.personMvc = standalone(personControllerCtor.newInstance(personRepo, mapper, validator));
    }

    /**
     * Issue an M:N traversal request. Dispatches to the controller owning the
     * source URL segment ({@code /api/posts/...} → PostController,
     * {@code /api/persons/...} → PersonController).
     */
    public Response exchange(String method, String path) throws Exception {
        MockMvc mvc = path.startsWith("/api/posts") ? postMvc : personMvc;
        MvcResult result = mvc.perform(
            request(HttpMethod.valueOf(method), URI.create(path))).andReturn();
        String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Response(result.getResponse().getStatus(), body);
    }

    public Object parseBody(String body) throws Exception {
        if (body == null || body.isEmpty()) return null;
        return mapper.readValue(body, Object.class);
    }

    @Override public void close() throws Exception { classLoader.close(); }

    public record Response(int status, String body) {}

    // -----------------------------------------------------------------------
    // setup helpers
    // -----------------------------------------------------------------------

    private MockMvc standalone(Object controller) {
        MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter();
        converter.setObjectMapper(mapper);
        return MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build();
    }

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
