package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * F22 — host the GENERATED Java Spring {@code @RestController} for the view-only
 * {@code InvoiceSummary} projection over HTTP (in-process via Spring MockMvc) and drive
 * the {@code projection/} api-contract scenarios against it. Sibling of
 * {@link GeneratedJsonbControllerHarness}.
 *
 * <p>The artifact under test is the GENERATED {@code InvoiceSummaryController} —
 * read routes plus a 405 refusal on every write verb — together with the read-only
 * {@code InvoiceSummaryRepository} interface it delegates to. The only hand-written
 * piece is {@link InMemoryInvoiceSummaryRepositorySource}, the consumer seam.</p>
 *
 * <p>Both the projection AND the writable {@code Invoice} entity are generated and
 * compiled, because the interesting failure is a gate that admits one shape and breaks
 * the other. Only the projection's controller is MOUNTED — mounting Invoice's too would
 * need a second in-memory seam for a surface no scenario exercises.</p>
 */
public final class GeneratedProjectionControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.sales";
    private static final String CONTROLLER_FQCN = ENTITY_PKG + ".InvoiceSummaryController";
    private static final String DTO_FQCN = ENTITY_PKG + ".InvoiceSummaryDto";
    private static final String REPO_FQCN = ENTITY_PKG + ".InvoiceSummaryRepository";

    private final ObjectMapper mapper = new ObjectMapper();
    private final URLClassLoader classLoader;
    private final Class<?> dtoClass;
    private final Constructor<?> controllerCtor;   // (InvoiceSummaryRepository) — no ObjectMapper,
                                                   // no Validator: nothing here binds a body.
    private final Constructor<?> repoCtor;         // (List<InvoiceSummaryDto> seed)
    private final List<Map<String, Object>> seedRows;

    private MockMvc mockMvc;

    public GeneratedProjectionControllerHarness(Path corpusRoot, Path genDir,
                                                List<Map<String, Object>> seedRows) throws Exception {
        this.seedRows = seedRows;

        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        // The projection's controller must have been emitted at all — a silently-skipped
        // generator would otherwise surface downstream as a ClassNotFoundException with no
        // hint that codegen, not the harness, was the cause.
        Path emittedController = srcDir.resolve(ENTITY_PKG.replace('.', '/'))
            .resolve("InvoiceSummaryController.java");
        if (!Files.exists(emittedController)) {
            throw new IllegalStateException(
                "no controller was generated for the InvoiceSummary projection at "
                    + emittedController + " — the F22 emit gate did not admit it");
        }

        Path repoImpl = srcDir.resolve(ENTITY_PKG.replace('.', '/'))
            .resolve("InMemoryInvoiceSummaryRepository.java");
        Files.writeString(repoImpl, InMemoryInvoiceSummaryRepositorySource.SOURCE);

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        this.dtoClass = classLoader.loadClass(DTO_FQCN);
        Class<?> repoInterface = classLoader.loadClass(REPO_FQCN);
        Class<?> controllerClass = classLoader.loadClass(CONTROLLER_FQCN);
        this.controllerCtor = controllerClass.getDeclaredConstructor(repoInterface);
        Class<?> repoImplClass = classLoader.loadClass(InMemoryInvoiceSummaryRepositorySource.FQCN);
        this.repoCtor = repoImplClass.getDeclaredConstructor(List.class);
    }

    /** Re-seed for a scenario: fresh repo + controller + MockMvc from the corpus seed. */
    public void reset() throws Exception {
        List<Object> dtos = new ArrayList<>();
        for (Map<String, Object> row : seedRows) dtos.add(mapper.convertValue(row, dtoClass));
        Object repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo);

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
    // setup helpers (mirror GeneratedJsonbControllerHarness)
    // -----------------------------------------------------------------------

    private static MetaDataLoader loadCorpus(Path metaJson) {
        URI uri = URIHelper.toURI(
            "model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-projection-generated");
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
}
