package com.metaobjects.integration.api.generated;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringRepositoryGenerator;
import com.metaobjects.integration.api.TomcatHost;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Host the GENERATED Spring {@code TicketController} of the {@code enum-default} sub-corpus over
 * real HTTP (embedded Tomcat) and drive its scenarios. Sibling of
 * {@link GeneratedAccountControllerHarness}; the only hand-written piece is
 * {@link InMemoryTicketRepositorySource}, the consumer seam.
 */
public final class GeneratedTicketControllerHarness implements AutoCloseable {

    private static final String ENTITY_PKG = "acme.defaults";

    private final ObjectMapper mapper = new ObjectMapper();
    private final URLClassLoader classLoader;
    private final Class<?> dtoClass;
    private final Constructor<?> controllerCtor;
    private final Constructor<?> repoCtor;
    private final List<Map<String, Object>> seedRows;
    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    private TomcatHost host;

    /**
     * @param corpusRoot {@code fixtures/api-contract-conformance/enum-default}
     * @param configRoot {@code fixtures/api-contract-conformance} (holds the committed config)
     */
    public GeneratedTicketControllerHarness(Path corpusRoot, Path configRoot, Path genDir,
                                            List<Map<String, Object>> seedRows) throws Exception {
        this.seedRows = seedRows;
        Path srcDir = genDir.resolve("src");
        Path classesDir = genDir.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        MetaDataLoader loader = loadCorpus(corpusRoot.resolve("meta.json"));
        loader.getRoot().setPhysicalNaming(
                com.metaobjects.config.SourceResolver.resolvePhysicalNaming(configRoot));
        loader.getRoot().setWireFormat(
                com.metaobjects.config.SourceResolver.discoverWireFormat(List.of(configRoot.toUri()))
                        .orElse(com.metaobjects.config.WireFormat.DEFAULT));

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        runGenerator(new SpringDtoGenerator(), loader, srcDir);
        runGenerator(new SpringRepositoryGenerator(), loader, srcDir);
        runGenerator(new SpringFilterAllowlistGenerator(), loader, srcDir);

        Path repoImpl = srcDir.resolve(ENTITY_PKG.replace('.', '/')).resolve("InMemoryTicketRepository.java");
        Files.createDirectories(repoImpl.getParent());
        Files.writeString(repoImpl, InMemoryTicketRepositorySource.SOURCE);

        compile(srcDir, classesDir);

        this.classLoader = new URLClassLoader(
            new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader());
        this.dtoClass = classLoader.loadClass(ENTITY_PKG + ".TicketDto");
        Class<?> repoInterface = classLoader.loadClass(ENTITY_PKG + ".TicketRepository");
        this.controllerCtor = classLoader.loadClass(ENTITY_PKG + ".TicketController")
            .getDeclaredConstructor(repoInterface, ObjectMapper.class, Validator.class);
        this.repoCtor = classLoader.loadClass(InMemoryTicketRepositorySource.FQCN)
            .getDeclaredConstructor(List.class);
    }

    /** Re-seed for a scenario: a fresh repository, controller and Tomcat. */
    public void reset() throws Exception {
        List<Object> dtos = new ArrayList<>();
        for (Map<String, Object> row : seedRows) dtos.add(mapper.convertValue(row, dtoClass));
        Object repo = repoCtor.newInstance(dtos);
        Object controller = controllerCtor.newInstance(repo, mapper, validator);
        if (host != null) host.close();
        this.host = TomcatHost.start(mapper, controller);
    }

    public Response exchange(String method, String path, Object jsonBody) throws Exception {
        TomcatHost.Response res = host.exchange(
            method, path, jsonBody == null ? null : mapper.writeValueAsString(jsonBody));
        return new Response(res.status(), res.body());
    }

    public Object parseBody(String body) {
        return TomcatHost.parseBody(mapper, body);
    }

    @Override
    public void close() throws Exception {
        if (host != null) host.close();
        classLoader.close();
    }

    public record Response(int status, String body) {}

    private static MetaDataLoader loadCorpus(Path... metaJsons) {
        List<URI> uris = new ArrayList<>();
        for (Path metaJson : metaJsons) {
            uris.add(URIHelper.toURI("model:file:" + metaJson.toAbsolutePath().toString().replace('\\', '/')));
        }
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "api-contract-enum-default-generated");
        loader.setSourceURIs(uris);
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
        if (sources.isEmpty()) throw new IllegalStateException("no generated .java sources under " + srcDir);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            throw new IllegalStateException("JDK (not JRE) required — getSystemJavaCompiler() returned null");
        }
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        // -parameters: the generated controller relies on reflective parameter names, as Spring Boot builds do.
        List<String> opts = List.of("-classpath", cp, "-d", classesDir.toString(), "-parameters");

        if (!javac.getTask(null, fm, diags, opts, null, fm.getJavaFileObjectsFromFiles(sources)).call()) {
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
