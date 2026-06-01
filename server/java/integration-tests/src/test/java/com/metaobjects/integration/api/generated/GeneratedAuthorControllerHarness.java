package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
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
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * SP-F Unit 1 — host the GENERATED Java Spring {@code @RestController} for the
 * {@code Author} corpus entity over HTTP (in-process via Spring MockMvc) and
 * drive the api-contract scenarios against it.
 *
 * <p>Mechanism (the SP-C / SP-E generate→compile→load pattern):</p>
 * <ol>
 *   <li>Load {@code fixtures/api-contract-conformance/meta.json} into a
 *       {@link MetaDataLoader}.</li>
 *   <li>Run the four codegen-spring generators — {@link SpringControllerGenerator},
 *       {@link SpringDtoGenerator}, {@link SpringRepositoryGenerator},
 *       {@link SpringFilterAllowlistGenerator} — for {@code Author} into a temp
 *       dir. The {@code AuthorController} emitted here is the artifact under
 *       test; it is hosted UNMODIFIED.</li>
 *   <li>Emit the ONLY hand-written piece — the in-memory
 *       {@link InMemoryAuthorRepositorySource} (the consumer seam behind the
 *       generated {@code AuthorRepository} interface) — into the same dir so it
 *       compiles against the generated interface + DTO.</li>
 *   <li>Compile every emitted source with the system Java compiler (classpath =
 *       the test classpath, so {@code FilterPredicate} etc. resolve); load via a
 *       child-first-of-test {@link URLClassLoader}.</li>
 *   <li>Instantiate the in-memory repo (seeded from {@code seed.json}) and the
 *       generated controller (constructor-injecting the repo), build a
 *       {@code MockMvc} via {@code standaloneSetup} (no Spring Boot context, no
 *       socket — same in-process fidelity as the TS lane's {@code fastify.inject}).</li>
 * </ol>
 *
 * <p>The harness is re-seeded per scenario (a fresh repo + controller +
 * MockMvc), matching the per-scenario isolation the hand-rolled lane gets from
 * TRUNCATE/seed.</p>
 */
public final class GeneratedAuthorControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.blog";
    private static final String CONTROLLER_FQCN = ENTITY_PKG + ".AuthorController";
    private static final String DTO_FQCN = ENTITY_PKG + ".AuthorDto";
    private static final String REPO_FQCN = ENTITY_PKG + ".AuthorRepository";

    // Corpus wire timestamps are zone-less wall-clock (yyyy-MM-ddTHH:mm:ss).
    private static final DateTimeFormatter WALL =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    /** Jackson mapper used both by MockMvc's converter and to (de)serialize bodies. */
    private final ObjectMapper mapper;
    private final URLClassLoader classLoader;
    private final Class<?> dtoClass;
    private final Constructor<?> dtoCtor;       // (Long id, String name, String bio, LocalDateTime createdAt)
    private final Constructor<?> controllerCtor;
    private final Constructor<?> repoCtor;       // (List<AuthorDto> seed)
    private final List<Map<String, Object>> seedRows;

    private MockMvc mockMvc;

    /**
     * One-time setup shared by all scenarios: generate, compile, load. The
     * compiled artifacts + classloader are reused; only the seeded repo +
     * controller + MockMvc are rebuilt per scenario.
     *
     * @param corpusRoot fixtures/api-contract-conformance
     * @param genDir     a temp dir (sources + classes are written under it)
     * @param seedRows   the corpus seed rows
     */
    public GeneratedAuthorControllerHarness(Path corpusRoot, Path genDir, List<Map<String, Object>> seedRows)
            throws Exception {
        this.seedRows = seedRows;
        this.mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        // 1. Load the corpus metadata.
        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));

        // 2. Run the four generators — emit the GENERATED controller + DTO + repo interface +
        //    filter allowlist into srcDir, UNMODIFIED.
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        // 3. Emit the ONLY hand-written piece — the in-memory repo impl — alongside.
        Path repoImpl = srcDir.resolve(ENTITY_PKG.replace('.', '/'))
            .resolve("InMemoryAuthorRepository.java");
        Files.createDirectories(repoImpl.getParent());
        Files.writeString(repoImpl, InMemoryAuthorRepositorySource.SOURCE);

        // 4. Compile everything against the test classpath.
        compile(srcDir, classesDir);

        // 5. Load the compiled classes (child of the test loader so Spring + runtime types resolve).
        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        this.dtoClass = classLoader.loadClass(DTO_FQCN);
        this.dtoCtor = dtoClass.getDeclaredConstructor(
            Long.class, String.class, String.class, LocalDateTime.class);
        Class<?> repoInterface = classLoader.loadClass(REPO_FQCN);
        Class<?> controllerClass = classLoader.loadClass(CONTROLLER_FQCN);
        this.controllerCtor = controllerClass.getDeclaredConstructor(repoInterface);
        Class<?> repoImplClass = classLoader.loadClass(InMemoryAuthorRepositorySource.FQCN);
        this.repoCtor = repoImplClass.getDeclaredConstructor(List.class);
    }

    /**
     * Re-seed for a scenario. {@code seed=false} hosts an empty repo (the
     * {@code list-empty} scenario's TRUNCATE analogue); otherwise the 5 corpus
     * authors are loaded fresh.
     */
    public void reset(boolean seed) throws Exception {
        List<Object> dtos = new ArrayList<>();
        if (seed) {
            for (Map<String, Object> row : seedRows) dtos.add(dtoFromRow(row));
        }
        Object repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo);

        MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter();
        converter.setObjectMapper(mapper);
        this.mockMvc = MockMvcBuilders.standaloneSetup(controller)
            .setMessageConverters(converter)
            .build();
    }

    /** Issue a scenario request and return the (status, body-string) pair. */
    public Response exchange(String method, String path, Object jsonBody) throws Exception {
        MockHttpServletRequestBuilder builder = request(
            org.springframework.http.HttpMethod.valueOf(method), URI.create(path));
        if (jsonBody != null) {
            builder.contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                   .content(mapper.writeValueAsString(jsonBody));
        }
        MvcResult result = mockMvc.perform(builder).andReturn();
        String body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return new Response(result.getResponse().getStatus(), body);
    }

    /** Parse a response body string into Map/List/scalar/null (the assertion shape). */
    public Object parseBody(String body) throws Exception {
        if (body == null || body.isEmpty()) return null;
        return mapper.readValue(body, Object.class);
    }

    @Override
    public void close() throws Exception {
        classLoader.close();
    }

    /** HTTP status + raw body string. */
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
            "api-contract-generated");
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }

    /** Run one MultiFileDirectGenerator into {@code outDir} via its {@code outputDir} arg. */
    private static void runGenerator(Object generator, MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        // All four generators extend MultiFileDirectGeneratorBase; setArgs + execute are shared.
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).setArgs(args);
        ((com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?>) generator).execute(loader);
    }

    private static void compile(Path srcDir, Path classesDir) throws Exception {
        List<File> sources;
        try (Stream<Path> s = Files.walk(srcDir)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        if (sources.isEmpty()) {
            throw new IllegalStateException("no generated .java sources under " + srcDir);
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            throw new IllegalStateException(
                "JDK (not JRE) required — ToolProvider.getSystemJavaCompiler() returned null");
        }
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        // -parameters: Spring resolves @RequestParam/@PathVariable without an explicit
        // name= from the reflective parameter name. Spring Boot's build compiles with this
        // flag by default; the generated controller legitimately relies on it. This is a
        // host-compilation concern, not generated code — we host the controller as-is.
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString(), "-parameters");

        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            throw new IllegalStateException(sb.toString());
        }
    }

    /** Build a generated {@code AuthorDto} from a seed row map. */
    private Object dtoFromRow(Map<String, Object> row) throws Exception {
        Long id = row.get("id") == null ? null : ((Number) row.get("id")).longValue();
        String name = (String) row.get("name");
        String bio = (String) row.get("bio");
        Object createdRaw = row.get("createdAt");
        LocalDateTime createdAt = createdRaw == null
            ? null
            : LocalDateTime.parse(String.valueOf(createdRaw), WALL);
        return dtoCtor.newInstance(id, name, bio, createdAt);
    }
}
