package com.metaobjects.integration.api.tph.generated;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.module.SimpleModule;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
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
import org.springframework.http.MediaType;
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
import java.math.BigDecimal;
import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * FR-017 Tier 4/5 — host the GENERATED Java Spring {@code @RestController} for the TPH corpus
 * ({@code Auth} base + {@code Bridge}/{@code Copay}/{@code PriorAuth} subtypes) over HTTP
 * (in-process via Spring MockMvc) and drive the polymorphic-CRUD scenarios against it.
 *
 * <p>Mechanism (the SP-F generate→compile→load pattern, mirroring
 * {@code GeneratedAuthorControllerHarness} / {@code GeneratedM2mControllerHarness}):</p>
 * <ol>
 *   <li>load {@code fixtures/api-contract-conformance/tph/meta.json};</li>
 *   <li>run the four codegen-spring generators — the emitted {@code AuthController} (polymorphic
 *       GET + per-subtype CRUD) is the artifact under test, hosted UNMODIFIED;</li>
 *   <li>emit the ONLY hand-written piece — the in-memory {@link InMemoryAuthRepositorySource}
 *       (the consumer seam behind the generated TPH {@code AuthRepository} interface) — alongside;</li>
 *   <li>compile everything with the system Java compiler; load via a child-of-test
 *       {@link URLClassLoader};</li>
 *   <li>seed the in-memory repo from {@code tph/seed.json} (one row per subtype), instantiate the
 *       generated controller, and host on a {@code MockMvc} {@code standaloneSetup} (no Spring Boot
 *       context, no socket).</li>
 * </ol>
 *
 * <p>The harness is built ONCE (generate→compile→load is expensive); the controller's MockMvc is
 * rebuilt from a fresh seed in {@link #reset()} per scenario (each TPH scenario mutates the table).</p>
 */
public final class GeneratedTphControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.auth";
    private static final String CONTROLLER_FQCN = ENTITY_PKG + ".AuthController";
    private static final String DTO_FQCN = ENTITY_PKG + ".AuthDto";
    private static final String REPO_FQCN = ENTITY_PKG + ".AuthRepository";

    // ADR-0045 (#203/#229): autoCreatedAt/autoUpdatedAt are bare field.timestamp → instant/tz-aware,
    // so the generated union AuthDto carries them as java.time.Instant. The corpus seed/scenario
    // values are offset-less wall-clock (yyyy-MM-ddTHH:mm:ss); an offset-less value is interpreted
    // as UTC (the cross-port instant wire contract — mirrors GeneratedAuthorControllerHarness).
    private static final String UTC_SUFFIX = "Z";

    private final ObjectMapper mapper;
    private final URLClassLoader classLoader;
    // (Long id, AuthType type, String reference, Instant autoCreatedAt, Instant autoUpdatedAt,
    //  Integer quantity, BigDecimal copayAmount, String approver)
    private final Constructor<?> dtoCtor;
    private final Class<?> authTypeClass;        // the generated value-constrained enum discriminator (AuthDto.AuthType)
    private final Constructor<?> controllerCtor; // (AuthRepository, ObjectMapper, Validator)
    private final Constructor<?> repoCtor;       // (List<AuthDto> seed)
    private final List<Map<String, Object>> seedRows;
    // FR-036 Program B: the generated TPH controller now injects a jakarta Validator (3-arg ctor)
    // so its per-subtype update can enforce present-value constraints over HTTP. One reference-impl
    // validator for the harness (mirrors GeneratedAuthorControllerHarness).
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    private MockMvc mockMvc;

    public GeneratedTphControllerHarness(Path corpusRoot, Path genDir, List<Map<String, Object>> seedRows)
            throws Exception {
        this.seedRows = seedRows;
        // ADR-0045 (#203/#229): the union AuthDto now carries two java.time.Instant components
        // (autoCreatedAt, autoUpdatedAt). Register JavaTimeModule (Instant serialization) plus a
        // lenient Instant deserializer that treats an offset-less value as UTC — mirrors
        // GeneratedAuthorControllerHarness's UTC Instant handling for the vanilla @autoSet gate.
        SimpleModule utcInstant = new SimpleModule()
            .addDeserializer(Instant.class, new JsonDeserializer<Instant>() {
                @Override
                public Instant deserialize(JsonParser p, DeserializationContext ctx)
                        throws java.io.IOException {
                    String raw = p.getValueAsString();
                    if (raw == null || raw.isEmpty()) return null;
                    return parseInstant(raw);
                }
            });
        this.mapper = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .registerModule(utcInstant)
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        // 1. Load the TPH corpus.
        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("tph/meta.json"));

        // 2. Generate controller + DTOs + repository interface + filter allowlist. For the TPH base
        //    Auth this emits the polymorphic + per-subtype controller, the union AuthDto, and the
        //    TPH AuthRepository; the subtypes emit only their (unused) standalone DTOs.
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        // 3. Emit the hand-written in-memory consumer-seam repo.
        Path pkgDir = srcDir.resolve(ENTITY_PKG.replace('.', '/'));
        Files.createDirectories(pkgDir);
        Files.writeString(pkgDir.resolve("InMemoryAuthRepository.java"), InMemoryAuthRepositorySource.SOURCE);

        // 4. Compile everything against the test classpath.
        compile(srcDir, classesDir);

        // 5. Load the compiled classes (child of the test loader so Spring + runtime types resolve).
        this.classLoader = new URLClassLoader(new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        Class<?> dtoClass = classLoader.loadClass(DTO_FQCN);
        // `type` is the value-constrained enum discriminator (field.enum): the generated DTO ctor
        // takes the nested AuthType, not String. Resolve the enum reflectively to build seed rows.
        this.authTypeClass = classLoader.loadClass(DTO_FQCN + "$AuthType");
        // ADR-0045 (#203/#229): the DTO record now carries the two @autoSet timestamp columns
        // (autoCreatedAt onCreate, autoUpdatedAt onUpdate) right after the base's own scalars, in
        // declared order — before the folded-in subtype-only columns.
        // FR-037 R1 adds `issuedCurrency` (@mutability "writeOnce") on the BASE, so it lands
        // among the base's own scalars in declared order, before the @autoSet pair.
        this.dtoCtor = dtoClass.getDeclaredConstructor(
            Long.class, authTypeClass, String.class, String.class, Instant.class, Instant.class,
            Integer.class, BigDecimal.class, String.class);
        Class<?> repoInterface = classLoader.loadClass(REPO_FQCN);
        this.controllerCtor = classLoader.loadClass(CONTROLLER_FQCN)
            .getDeclaredConstructor(repoInterface, ObjectMapper.class, Validator.class);
        this.repoCtor = classLoader.loadClass(InMemoryAuthRepositorySource.FQCN).getDeclaredConstructor(List.class);
    }

    /** Rebuild the controller's MockMvc from a fresh seed (per-scenario isolation). */
    public void reset() throws Exception {
        List<Object> dtos = new ArrayList<>();
        for (Map<String, Object> row : seedRows) dtos.add(dtoFromRow(row));
        Object repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo, mapper, validator);

        MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter();
        converter.setObjectMapper(mapper);
        this.mockMvc = MockMvcBuilders.standaloneSetup(controller).setMessageConverters(converter).build();
    }

    /** Issue a scenario request and return the (status, body-string) pair. */
    public Response exchange(String method, String path, Object jsonBody) throws Exception {
        MockHttpServletRequestBuilder builder = request(HttpMethod.valueOf(method), URI.create(path));
        if (jsonBody != null) {
            builder.contentType(MediaType.APPLICATION_JSON).content(mapper.writeValueAsString(jsonBody));
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

    @Override public void close() throws Exception { classLoader.close(); }

    public record Response(int status, String body) {}

    // -----------------------------------------------------------------------
    // setup helpers
    // -----------------------------------------------------------------------

    /**
     * Build a generated union {@code AuthDto} from a seed row map (one TPH table row).
     *
     * <p>ADR-0045 (#203/#229): {@code autoCreatedAt}/{@code autoUpdatedAt} are read from the seed
     * VERBATIM (the OLD sentinel) — this is a DIRECT insert into the in-memory repo behind the
     * controller's repository seam, NOT a stamping POST, so a seeded row keeps its old values. A
     * later PATCH bumps autoUpdatedAt (server-owned, via the generated controller's
     * {@code patch.stampAutoSetOnUpdate()}) while autoCreatedAt stays old — the fieldsNotEqual
     * divergence the gate scenario asserts.</p>
     */
    private Object dtoFromRow(Map<String, Object> row) throws Exception {
        Long id = row.get("id") == null ? null : ((Number) row.get("id")).longValue();
        String type = (String) row.get("type");
        String reference = (String) row.get("reference");
        // FR-037 R1: the @mutability "writeOnce" column, seeded verbatim.
        String issuedCurrency = (String) row.get("issuedCurrency");
        Object autoCreatedRaw = row.get("autoCreatedAt");
        Instant autoCreatedAt = autoCreatedRaw == null ? null : parseInstant(String.valueOf(autoCreatedRaw));
        Object autoUpdatedRaw = row.get("autoUpdatedAt");
        Instant autoUpdatedAt = autoUpdatedRaw == null ? null : parseInstant(String.valueOf(autoUpdatedRaw));
        Integer quantity = row.get("quantity") == null ? null : ((Number) row.get("quantity")).intValue();
        Object copayRaw = row.get("copayAmount");
        BigDecimal copayAmount = copayRaw == null ? null : new BigDecimal(String.valueOf(copayRaw));
        String approver = (String) row.get("approver");
        // Coerce the seed's String discriminator into the generated AuthType enum value.
        @SuppressWarnings({ "unchecked", "rawtypes" })
        Object typeEnum = type == null ? null : Enum.valueOf((Class) authTypeClass, type);
        return dtoCtor.newInstance(
            id, typeEnum, reference, issuedCurrency, autoCreatedAt, autoUpdatedAt,
            quantity, copayAmount, approver);
    }

    /**
     * Parse a corpus timestamp string into an {@link Instant}. Corpus values are offset-less
     * wall-clock (yyyy-MM-ddTHH:mm:ss); per the instant wire contract an offset-less value is
     * interpreted as UTC, so we append {@code Z} when no zone is present before
     * {@code Instant.parse} (ISO-8601 with {@code Z}).
     */
    private static Instant parseInstant(String raw) {
        String s = (raw.endsWith(UTC_SUFFIX) || raw.contains("+")) ? raw : raw + UTC_SUFFIX;
        return Instant.parse(s);
    }

    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "api-contract-tph-generated");
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
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
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
        if (sources.isEmpty()) throw new IllegalStateException("no generated .java sources under " + srcDir);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null)
            throw new IllegalStateException("JDK (not JRE) required — getSystemJavaCompiler() returned null");
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        // -parameters: Spring resolves @PathVariable/@RequestParam without an explicit name= from
        // the reflective parameter name (the generated controller relies on it, as the other lanes do).
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
}
