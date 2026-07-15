package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.generator.spring.SpringValueObjectGenerator;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import jakarta.validation.Validation;
import jakarta.validation.Validator;

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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * #98 — host the GENERATED Java Spring {@code @RestController} for the
 * {@code Document} (open-bag jsonb) corpus entity over HTTP (in-process via
 * Spring MockMvc) and drive the api-contract scenarios against it. Mirror of
 * {@link GeneratedAuthorControllerHarness} for the single-entity jsonb corpus.
 *
 * <p>The artifact under test is the GENERATED {@code DocumentController} +
 * {@code DocumentDto} — whose {@code payload} field is {@code Object} (#103), so
 * a posted JSON object binds and a stored bag serialises as parsed JSON. The
 * only hand-written piece is the in-memory {@link InMemoryDocumentRepositorySource}
 * (the consumer seam behind the generated {@code DocumentRepository}).</p>
 */
public final class GeneratedJsonbControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.store";
    private static final String CONTROLLER_FQCN = ENTITY_PKG + ".DocumentController";
    private static final String DTO_FQCN = ENTITY_PKG + ".DocumentDto";
    private static final String REPO_FQCN = ENTITY_PKG + ".DocumentRepository";

    private final ObjectMapper mapper = new ObjectMapper();
    private final URLClassLoader classLoader;
    private final Class<?> dtoClass;             // acme.store.DocumentDto (record w/ VO components)
    private final Constructor<?> controllerCtor;
    private final Constructor<?> repoCtor;        // (List<DocumentDto> seed)
    private final List<Map<String, Object>> seedRows;
    // FR-036: the generated controller now injects a jakarta Validator (3-arg ctor).
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    private MockMvc mockMvc;

    public GeneratedJsonbControllerHarness(Path corpusRoot, Path genDir, List<Map<String, Object>> seedRows)
            throws Exception {
        this.seedRows = seedRows;

        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        // 1. Load the corpus metadata.
        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));

        // 2. Run the generators — emit the GENERATED controller + DTO + repo interface +
        //    filter allowlist + value-object records (Program D) into srcDir, UNMODIFIED.
        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);
        runGenerator(new SpringValueObjectGenerator(), loader, srcDir);

        // 3. Emit the ONLY hand-written piece — the in-memory repo impl — alongside.
        Path repoImpl = srcDir.resolve(ENTITY_PKG.replace('.', '/'))
            .resolve("InMemoryDocumentRepository.java");
        Files.createDirectories(repoImpl.getParent());
        Files.writeString(repoImpl, InMemoryDocumentRepositorySource.SOURCE);

        // 4. Compile everything against the test classpath.
        compile(srcDir, classesDir);

        // 5. Load the compiled classes (child of the test loader so Spring + runtime types resolve).
        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        this.dtoClass = classLoader.loadClass(DTO_FQCN);
        Class<?> repoInterface = classLoader.loadClass(REPO_FQCN);
        Class<?> controllerClass = classLoader.loadClass(CONTROLLER_FQCN);
        this.controllerCtor = controllerClass.getDeclaredConstructor(
            repoInterface, ObjectMapper.class, Validator.class);
        Class<?> repoImplClass = classLoader.loadClass(InMemoryDocumentRepositorySource.FQCN);
        this.repoCtor = repoImplClass.getDeclaredConstructor(List.class);
    }

    /** Re-seed for a scenario: fresh repo + controller + MockMvc from the corpus seed. */
    public void reset() throws Exception {
        List<Object> dtos = new ArrayList<>();
        for (Map<String, Object> row : seedRows) dtos.add(dtoFromRow(row));
        Object repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo, mapper, validator);

        MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter();
        converter.setObjectMapper(mapper);
        this.mockMvc = MockMvcBuilders.standaloneSetup(controller)
            .setMessageConverters(converter)
            .build();
    }

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

    public Object parseBody(String body) throws Exception {
        if (body == null || body.isEmpty()) return null;
        return mapper.readValue(body, Object.class);
    }

    @Override
    public void close() throws Exception {
        classLoader.close();
    }

    public record Response(int status, String body) {}

    // -----------------------------------------------------------------------
    // setup helpers (mirror GeneratedAuthorControllerHarness)
    // -----------------------------------------------------------------------

    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-jsonb-generated");
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

    /**
     * Build a generated {@code DocumentDto} from a seed row map. Jackson {@code convertValue}
     * binds the whole record — {@code payload} stays an {@code Object} (open JSON bag), and the
     * value-object columns ({@code primaryMarker} / {@code optionalMarker} / {@code markers})
     * convert to the generated {@code Marker} record / {@code List<Marker>} (Program D). An
     * absent VO key on a seed row becomes {@code null}.
     */
    private Object dtoFromRow(Map<String, Object> row) {
        return mapper.convertValue(row, dtoClass);
    }
}
